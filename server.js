require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");
const pool = require("./config/db");
const aiController = require("./controllers/ai_controller");
const authRoutes = require("./routes/authRoutes");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: "mqtts",
  port: 8883,
  rejectUnauthorized: false,
});
s;

mqttClient.on("connect", () => {
  console.log("✅ Terhubung ke HiveMQ Broker!");
  mqttClient.subscribe(["devices/+/data", "devices/+/register"], (err) => {
    if (err) console.error("❌ Gagal subscribe:", err);
    else console.log("📡 Listening: Data & Register...");
  });
});

mqttClient.on("message", async (topic, message) => {
  try {
    const topicParts = topic.split("/");
    const deviceId = topicParts[1];
    const action = topicParts[2];

    if (action === "register") {
      const info = JSON.parse(message.toString());
      console.log(`🆕 [REGISTER] Sinyal dari ${deviceId}`);
      const query = `
          INSERT INTO devices (device_id, device_name, type, whatsapp_number)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (device_id) DO NOTHING
      `;
      await pool.query(query, [
        deviceId,
        info.device_name || `Perangkat ${deviceId}`,
        info.type || "unknown",
        "",
      ]);
      return;
    }

    if (action === "data") {
      let rawData = JSON.parse(message.toString());
      let data = Array.isArray(rawData) ? rawData[0] : rawData;

      const gasValue = data.gas_ppm !== undefined ? data.gas_ppm : data.amonia;
      if (data.temperature === undefined || gasValue === undefined) return;

      console.log(
        `📥 [DATA] ${deviceId}: Suhu=${data.temperature}, Gas=${gasValue}`,
      );

      const ensureDeviceQuery = `
          INSERT INTO devices (device_id, device_name, type, whatsapp_number)
          VALUES ($1, $2, 'sensor', '')
          ON CONFLICT (device_id) DO NOTHING
      `;
      await pool.query(ensureDeviceQuery, [deviceId, `Perangkat ${deviceId}`]);

      await pool.query(
        "INSERT INTO sensor_data(device_id, temperature, humidity, gas_ppm) VALUES($1, $2, $3, $4)",
        [deviceId, data.temperature, data.humidity, gasValue],
      );

      const deviceRes = await pool.query(
        "SELECT * FROM devices WHERE device_id = $1",
        [deviceId],
      );
      if (deviceRes.rows.length === 0) return;

      const device = deviceRes.rows[0];
      let alertMessage = "";

      if (Number(data.temperature) > Number(device.threshold_temp)) {
        alertMessage = `⚠️ *PERINGATAN SUHU TINGGI!*\nLokasi: ${device.device_name}\nSuhu: ${data.temperature}°C`;
      } else if (Number(gasValue) > Number(device.threshold_gas)) {
        alertMessage = `⚠️ *PERINGATAN AMONIA TINGGI!*\nLokasi: ${device.device_name}\nGas: ${gasValue} PPM`;
      }

      if (
        alertMessage &&
        device.whatsapp_number &&
        device.whatsapp_number.length > 5
      ) {
        await sendWhatsApp(device.whatsapp_number, alertMessage);
      }
    }
  } catch (err) {
    console.error("❌ Error MQTT:", err);
  }
});

// --- API ENDPOINTS ---

app.get("/", (req, res) => res.send("🚀 Backend Maggenzim Running!"));
app.post("/api/chat", aiController.chatWithAssistant);
app.use("/auth", authRoutes);
app.post("/api/login", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone)
      return res.status(400).json({ error: "Nomor telepon wajib diisi" });
    let formatted = phone.replace(/\D/g, "");
    if (formatted.startsWith("0")) formatted = "62" + formatted.substring(1);

    const result = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1",
      [formatted],
    );

    if (result.rows.length > 0) {
      res.json({ status: "success", user: result.rows[0] });
    } else {
      res
        .status(404)
        .json({ status: "error", message: "Nomor belum terdaftar." });
    }
  } catch (err) {
    console.error("❌ Login Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/my-devices", async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id)
      return res
        .status(400)
        .json({ status: "error", message: "User ID diperlukan" });

    const query = `SELECT * FROM devices WHERE owned_by = $1 ORDER BY device_name ASC`;
    const result = await pool.query(query, [user_id]);

    res.json({ status: "success", data: result.rows });
  } catch (err) {
    console.error("Error My Devices:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.post("/api/claim-device", async (req, res) => {
  try {
    const { device_id, user_id, user_phone } = req.body;
    let formattedPhone = user_phone.replace(/\D/g, "");
    if (formattedPhone.startsWith("0"))
      formattedPhone = "62" + formattedPhone.substring(1);

    const check = await pool.query(
      "SELECT * FROM devices WHERE device_id = $1",
      [device_id],
    );
    if (check.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Perangkat belum dinyalakan/terdaftar.",
      });
    }
    const device = check.rows[0];

    if (device.owned_by !== null && device.owned_by != user_id) {
      return res.status(403).json({
        status: "error",
        message: "Perangkat sudah dimiliki orang lain!",
      });
    }

    await pool.query(
      "UPDATE devices SET owned_by = $1, whatsapp_number = $2 WHERE device_id = $3",
      [user_id, formattedPhone, device_id],
    );

    res.json({
      status: "success",
      message: "Perangkat berhasil diklaim.",
      type: device.type,
    });
  } catch (err) {
    console.error("❌ Claim Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.post("/api/release-device", async (req, res) => {
  try {
    const { device_id, user_id } = req.body;
    const result = await pool.query(
      "UPDATE devices SET owned_by = NULL, whatsapp_number = '' WHERE device_id = $1 AND owned_by = $2",
      [device_id, user_id],
    );

    if (result.rowCount === 0) {
      return res.status(403).json({
        status: "error",
        message: "Gagal hapus. Anda bukan pemilik sah.",
      });
    }

    console.log(`🗑️ Device ${device_id} dilepas User ${user_id}`);
    res.json({ status: "success", message: "Perangkat dihapus." });
  } catch (err) {
    console.error("❌ Release Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/api/sensor-data", async (req, res) => {
  try {
    const { id } = req.query;
    const query = `
      SELECT timestamp, temperature, humidity, gas_ppm AS amonia 
      FROM sensor_data 
      WHERE device_id = $1 
      AND timestamp >= NOW() - INTERVAL '7 days'
      ORDER BY timestamp ASC
    `;
    const result = await pool.query(query, [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "DB Error" });
  }
});

app.get("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    const result = await pool.query(
      "SELECT times FROM schedules WHERE device_id = $1",
      [id],
    );
    if (result.rows.length > 0) res.json(result.rows[0]);
    else res.json({ times: [] });
  } catch (err) {
    res.status(500).json({ error: "DB Error" });
  }
});

app.post("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    const newSchedule = req.body;
    await pool.query(
      `INSERT INTO schedules (device_id, times) VALUES ($1, $2) ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()`,
      [id, JSON.stringify(newSchedule.times)],
    );

    mqttClient.publish(
      `devices/${id}/commands/set_schedule`,
      JSON.stringify(newSchedule),
      { retain: true },
    );

    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/check-device", async (req, res) => {
  try {
    const { id } = req.query;
    const result = await pool.query(
      "SELECT * FROM devices WHERE device_id = $1",
      [id],
    );
    if (result.rows.length > 0)
      res.status(200).json({ status: "success", device: result.rows[0] });
    else res.status(404).json({ status: "error", message: "Not found" });
  } catch (err) {
    res.status(500).json({ error: "DB Error" });
  }
});

async function sendWhatsApp(to, message) {
  try {
    let formatted = to.trim().replace(/\D/g, "");
    if (formatted.startsWith("0")) formatted = "62" + formatted.substring(1);

    const response = await axios.post(
      "https://api.fonnte.com/send",
      {
        target: formatted,
        message: message,
        countryCode: "62",
      },
      {
        headers: {
          Authorization: process.env.FONNTE_TOKEN,
        },
      },
    );

    if (response.data.status) {
      console.log(`✅ WA Alert ke ${to}: Terkirim`);
    } else {
      console.error(`❌ WA Alert ke ${to} Gagal:`, response.data.reason);
    }
  } catch (err) {
    console.error("❌ Fonnte Error:", err.message);
  }
}

cron.schedule("0 0 * * *", async () => {
  console.log("🧹 [CRON] Memulai pembersihan data lama...");

  try {
    const query = `
      DELETE FROM sensor_data 
      WHERE timestamp < NOW() - INTERVAL '7 days'
    `;

    const result = await pool.query(query);

    console.log(
      `✅ [CRON] Selesai! Menghapus ${result.rowCount} baris data kadaluarsa.`,
    );
  } catch (err) {
    console.error("❌ [CRON] Gagal membersihkan data:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
