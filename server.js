// ========================================================
// Bismillah - Backend Smart Kandang Maggenzim (Production)
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

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// MQTT Client
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: "mqtts",
  port: 8883,
});

// --- LOGIKA MQTT ---
mqttClient.on("connect", () => {
  console.log("✅ Terhubung ke HiveMQ Broker!");

  // Subscribe hanya ke Data Sensor dan Registrasi Alat
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

    // 1. LOGIKA AUTO REGISTER
    if (action === "register") {
      const info = JSON.parse(message.toString());
      console.log(`🆕 [REGISTER] ${deviceId}`);

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

    // 2. LOGIKA DATA SENSOR
    if (action === "data") {
      let rawData = JSON.parse(message.toString());
      let data = Array.isArray(rawData) ? rawData[0] : rawData;

      const gasValue = data.gas_ppm !== undefined ? data.gas_ppm : data.amonia;
      if (data.temperature === undefined || gasValue === undefined) return;

      console.log(
        `📥 [DATA] ${deviceId}: Suhu=${data.temperature}, Gas=${gasValue}`
      );

      await pool.query(
        "INSERT INTO sensor_data(device_id, temperature, humidity, gas_ppm) VALUES($1, $2, $3, $4)",
        [deviceId, data.temperature, data.humidity, gasValue]
      );

      // Cek Threshold & Kirim WA
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

// --- API ROUTES ---
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

      const latestData = dataRes.rows[0];
      const replyMsg = `*${device.device_name}*\nSuhu: ${Number(
        latestData.temperature
      ).toFixed(1)}°C\nAmonia: ${Number(latestData.gas_ppm).toFixed(1)} PPM`;

      await sendWhatsApp(fromNumber, replyMsg);
    } catch (err) {
      console.error(err);
    }
  }
  res.status(200).send();
});

app.get("/", (req, res) => res.send("🚀 Backend Production Running!"));

app.get("/api/check-device", async (req, res) => {
  try {
    const { id } = req.query;
    const result = await pool.query(
      "SELECT device_id, device_name, threshold_temp, threshold_gas FROM devices WHERE device_id = $1",
      [id]
    );
    if (result.rows.length > 0)
      res.status(200).json({ status: "success", device: result.rows[0] });
    else res.status(404).json({ status: "error", message: "Not found" });
  } catch (err) {
    res.status(500).json({ error: "DB Error" });
  }
});

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

app.post("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    const newSchedule = req.body;
    await pool.query(
      `INSERT INTO schedules (device_id, times) VALUES ($1, $2) ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()`,
      [id, JSON.stringify(newSchedule.times)]
    );
    mqttClient.publish(
      `devices/${id}/commands/set_schedule`,
      JSON.stringify(newSchedule)
    );
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
    });
  } catch (err) {
    console.error(err);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));
