// ========================================================
// Bismillah - Backend Smart Kandang Maggenzim (Final v5.2)
// Fitur: Auth, Claim/Release, Auto-Register, Alerts
// Perbaikan: Auto-Provisioning on Data
// ========================================================

require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const twilio = require("twilio");
const cors = require("cors");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Twilio Client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// MQTT Client (HiveMQ)
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: "mqtts",
  port: 8883,
});

// ========================================================
// --- 1. LOGIKA MQTT (LISTENER) ---
// ========================================================
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

    // --- A. AUTO REGISTER (Saat Alat Nyala) ---
    if (action === "register") {
      const info = JSON.parse(message.toString());
      console.log(`🆕 [REGISTER] Sinyal dari ${deviceId}`);

      // Masukkan ke DB (Biarkan owned_by NULL)
      const query = `
          INSERT INTO devices (device_id, device_name, type, whatsapp_number)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (device_id) DO NOTHING
      `;
      await pool.query(query, [
        deviceId,
        info.device_name || `Perangkat ${deviceId}`,
        info.type || "unknown",
        "", // WA Kosong
      ]);
      return;
    }

    // --- B. DATA SENSOR ---
    if (action === "data") {
      let rawData = JSON.parse(message.toString());
      let data = Array.isArray(rawData) ? rawData[0] : rawData;

      const gasValue = data.gas_ppm !== undefined ? data.gas_ppm : data.amonia;
      if (data.temperature === undefined || gasValue === undefined) return;

      console.log(
        `📥 [DATA] ${deviceId}: Suhu=${data.temperature}, Gas=${gasValue}`
      );

      // [PERBAIKAN PENTING] Pastikan Device Ada Dulu (Auto-Provisioning)
      // Ini mencegah error Foreign Key jika register gagal/telat
      const ensureDeviceQuery = `
          INSERT INTO devices (device_id, device_name, type, whatsapp_number)
          VALUES ($1, $2, 'sensor', '')
          ON CONFLICT (device_id) DO NOTHING
      `;
      await pool.query(ensureDeviceQuery, [deviceId, `Perangkat ${deviceId}`]);

      // Simpan Riwayat
      await pool.query(
        "INSERT INTO sensor_data(device_id, temperature, humidity, gas_ppm) VALUES($1, $2, $3, $4)",
        [deviceId, data.temperature, data.humidity, gasValue]
      );

      // Cek Alert (Hanya jika ada pemilik)
      const deviceRes = await pool.query(
        "SELECT * FROM devices WHERE device_id = $1",
        [deviceId]
      );
      if (deviceRes.rows.length === 0) return;

      const device = deviceRes.rows[0];
      let alertMessage = "";

      if (Number(data.temperature) > Number(device.threshold_temp)) {
        alertMessage = `⚠️ PERINGATAN! Suhu di ${device.device_name} tinggi: ${data.temperature}°C.`;
      } else if (Number(gasValue) > Number(device.threshold_gas)) {
        alertMessage = `⚠️ PERINGATAN! Gas di ${device.device_name} tinggi: ${gasValue} PPM.`;
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

// ========================================================
// --- 2. API ENDPOINTS (FLUTTER) ---
// ========================================================

app.get("/", (req, res) => res.send("🚀 Backend Maggenzim Running!"));

// --- A. REGISTRASI USER ---
app.post("/api/register", async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "Data kurang" });

    // UPSERT (Buat baru atau Update nama jika HP sama)
    const query = `
      INSERT INTO users (full_name, phone_number) VALUES ($1, $2)
      ON CONFLICT (phone_number) DO UPDATE SET full_name = EXCLUDED.full_name
      RETURNING user_id, full_name, phone_number;
    `;
    const result = await pool.query(query, [name, phone]);

    res.json({ status: "success", user: result.rows[0] });
  } catch (err) {
    console.error("❌ Register Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --- A2. LOGIN USER (CEK NOMOR HP) ---
app.post("/api/login", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone)
      return res.status(400).json({ error: "Nomor telepon wajib diisi" });

    const result = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1",
      [phone]
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

// --- B. KLAIM PERANGKAT (PROVISIONING) ---
app.post("/api/claim-device", async (req, res) => {
  try {
    const { device_id, user_id, user_phone } = req.body;

    // 1. Cek Alat
    const check = await pool.query(
      "SELECT * FROM devices WHERE device_id = $1",
      [device_id]
    );
    if (check.rows.length === 0) {
      return res
        .status(404)
        .json({
          status: "error",
          message: "Perangkat belum dinyalakan/terdaftar.",
        });
    }
    const device = check.rows[0];

    // 2. Cek Kepemilikan (Security Check)
    if (device.owned_by !== null && device.owned_by != user_id) {
      return res
        .status(403)
        .json({
          status: "error",
          message: "Perangkat sudah dimiliki orang lain!",
        });
    }

    // 3. Klaim (Update Owner)
    await pool.query(
      "UPDATE devices SET owned_by = $1, whatsapp_number = $2 WHERE device_id = $3",
      [user_id, user_phone, device_id]
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

// --- C. RELEASE PERANGKAT (HAPUS KEPEMILIKAN) ---
app.post("/api/release-device", async (req, res) => {
  try {
    const { device_id, user_id } = req.body;

    // Reset owned_by jadi NULL hanya jika usernya cocok
    const result = await pool.query(
      "UPDATE devices SET owned_by = NULL, whatsapp_number = '' WHERE device_id = $1 AND owned_by = $2",
      [device_id, user_id]
    );

    if (result.rowCount === 0) {
      return res
        .status(403)
        .json({
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

// --- D. DATA SENSOR ---
app.get("/api/sensor-data", async (req, res) => {
  try {
    const { id } = req.query;
    const result = await pool.query(
      "SELECT timestamp, temperature, humidity, gas_ppm AS amonia FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 20",
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "DB Error" });
  }
});

// --- E. GET JADWAL ---
app.get("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    const result = await pool.query(
      "SELECT times FROM schedules WHERE device_id = $1",
      [id]
    );
    if (result.rows.length > 0) res.json(result.rows[0]);
    else res.json({ times: [] });
  } catch (err) {
    res.status(500).json({ error: "DB Error" });
  }
});

// --- F. UPDATE JADWAL (MQTT Retain) ---
app.post("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    const newSchedule = req.body;

    // DB Save
    await pool.query(
      `INSERT INTO schedules (device_id, times) VALUES ($1, $2) ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()`,
      [id, JSON.stringify(newSchedule.times)]
    );

    // MQTT Publish (Retain: true agar alat menerima walau baru nyala)
    mqttClient.publish(
      `devices/${id}/commands/set_schedule`,
      JSON.stringify(newSchedule),
      { retain: true }
    );

    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// --- G. CEK DEVICE (Legacy/Dashboard Check) ---
app.get("/api/check-device", async (req, res) => {
  try {
    const { id } = req.query;
    const result = await pool.query(
      "SELECT * FROM devices WHERE device_id = $1",
      [id]
    );
    if (result.rows.length > 0)
      res.status(200).json({ status: "success", device: result.rows[0] });
    else res.status(404).json({ status: "error", message: "Not found" });
  } catch (err) {
    res.status(500).json({ error: "DB Error" });
  }
});

// --- H. WHATSAPP WEBHOOK ---
app.post("/whatsapp-webhook", async (req, res) => {
  const incomingMsg = req.body.Body.toLowerCase().trim();
  const fromNumber = req.body.From;

  if (incomingMsg === "cek") {
    try {
      const deviceRes = await pool.query(
        "SELECT * FROM devices WHERE whatsapp_number = $1 LIMIT 1",
        [fromNumber]
      );
      if (deviceRes.rows.length === 0) {
        await sendWhatsApp(fromNumber, "Nomor Anda belum terdaftar.");
        return res.status(200).send();
      }
      const device = deviceRes.rows[0];
      const dataRes = await pool.query(
        "SELECT * FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1",
        [device.device_id]
      );

      if (dataRes.rows.length === 0) {
        await sendWhatsApp(fromNumber, "Belum ada data sensor.");
        return res.status(200).send();
      }

      const d = dataRes.rows[0];
      const reply = `*${device.device_name}*\nSuhu: ${Number(
        d.temperature
      ).toFixed(1)}°C\nAmonia: ${Number(d.gas_ppm).toFixed(1)} PPM`;
      await sendWhatsApp(fromNumber, reply);
    } catch (err) {
      console.error(err);
    }
  }
  res.status(200).send();
});

async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
    });
  } catch (err) {
    console.error("Twilio Error:", err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));
