// ========================================================
// Bismillah - Backend Smart Kandang Maggenzim (Auto-Register)
// ========================================================

require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const twilio = require("twilio");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: "mqtts",
  port: 8883,
});

// --- LOGIKA MQTT ---
mqttClient.on("connect", () => {
  console.log("✅ Terhubung ke HiveMQ Broker!");
  // Subscribe ke data DAN register
  mqttClient.subscribe("devices/+/data");
  mqttClient.subscribe("devices/+/register"); // <--- TOPIK BARU
});

mqttClient.on("message", async (topic, message) => {
  try {
    const topicParts = topic.split("/");
    const deviceId = topicParts[1];
    const action = topicParts[2]; // 'data' atau 'register'

    // === LOGIKA AUTO REGISTER (SAAT ALAT NYALA) ===
    if (action === "register") {
      const info = JSON.parse(message.toString());
      console.log(`🆕 Permintaan Register dari ${deviceId}:`, info);

      // Masukkan ke database jika belum ada
      // Default WA kosong, user nanti bisa update via Aplikasi/DB
      const query = `
        INSERT INTO devices (device_id, device_name, type, whatsapp_number)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (device_id) DO NOTHING
      `;
      // Nama default: "Perangkat Baru [ID]"
      await pool.query(query, [
        deviceId,
        info.device_name || `Perangkat ${deviceId}`,
        info.type || "unknown",
        "", // Nomor WA dikosongkan dulu
      ]);
      console.log(`✅ Perangkat ${deviceId} berhasil didaftarkan/sudah ada.`);
      return;
    }

    // === LOGIKA DATA SENSOR (SEPERTI BIASA) ===
    if (action === "data") {
      let rawData = JSON.parse(message.toString());
      let data = Array.isArray(rawData) ? rawData[0] : rawData;

      const gasValue = data.gas_ppm !== undefined ? data.gas_ppm : data.amonia;
      if (data.temperature === undefined || gasValue === undefined) return;

      console.log(
        `📥 Data ${deviceId}: Suhu=${data.temperature}, Gas=${gasValue}`
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

      if (alertMessage && device.whatsapp_number) {
        await sendWhatsApp(device.whatsapp_number, alertMessage);
      }
    }
  } catch (err) {
    console.error("❌ Error MQTT:", err);
  }
});

// ... (Sisa kode Webhook & API sama seperti sebelumnya) ...
// Agar tidak kepanjangan, bagian Webhook dan API di bawah ini TETAP SAMA
// dengan file server.js terakhir yang saya berikan.
// Pastikan Anda menyalin bagian bawahnya juga (API Routes & Listen).

app.post("/whatsapp-webhook", async (req, res) => {
  // ... (Logika Webhook sama) ...
  res.status(200).send();
});

app.get("/", (req, res) => res.send("🚀 Backend Running!"));

app.get("/api/check-device", async (req, res) => {
  // ... (Logika Check Device sama) ...
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });
    const result = await pool.query(
      "SELECT device_id, device_name, threshold_temp, threshold_gas FROM devices WHERE device_id = $1",
      [id]
    );
    if (result.rows.length > 0)
      res.status(200).json({ status: "success", device: result.rows[0] });
    else res.status(404).json({ status: "error", message: "Device not found" });
  } catch (err) {
    res.status(500).json({ error: "DB Error" });
  }
});

app.get("/api/sensor-data", async (req, res) => {
  // ... (Logika Sensor Data sama) ...
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
  // ... (Logika Get Schedule sama) ...
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
  // ... (Logika Post Schedule sama) ...
  try {
    const { id } = req.query;
    const newSchedule = req.body;
    const query = `INSERT INTO schedules (device_id, times) VALUES ($1, $2) ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()`;
    await pool.query(query, [id, JSON.stringify(newSchedule.times)]);
    const commandTopic = `devices/${id}/commands/set_schedule`;
    mqttClient.publish(commandTopic, JSON.stringify(newSchedule));
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

async function sendWhatsApp(to, message) {
  // ... (Fungsi WA sama) ...
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
