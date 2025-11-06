require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const cors = require("cors");

// --- 1. KONFIGURASI ---
const app = express();
app.use(cors());
app.use(express.json()); // Agar bisa baca JSON dari Flutter

const PORT = process.env.PORT || 3000;

// --- 2. KONEKSI DATABASE (NEON) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true, rejectUnauthorized: false }, // Wajib untuk Neon
});

// --- 3. KONEKSI MQTT (HIVEMQ) ---
const mqttClient = mqtt.connect(process.env.MQTT_HOST, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
  port: 8883,
  protocol: "mqtts", // Penting: gunakan MQTTS untuk SSL
});

mqttClient.on("connect", () => {
  console.log("✅ Backend terhubung ke HiveMQ!");
  // Subscribe ke SEMUA data dari perangkat sensor manapun
  mqttClient.subscribe("devices/+/data");
});

// --- 4. LOGIKA SAAT MENERIMA DATA SENSOR ---
mqttClient.on("message", async (topic, message) => {
  try {
    // Topik formatnya: devices/SENSOR-ID/data
    // Kita ambil ID perangkat dari topik
    const deviceId = topic.split("/")[1];

    // Parse data JSON dari perangkat
    // Ingat: Perangkat mengirim ARRAY, kita ambil item pertama
    const rawData = JSON.parse(message.toString());
    const data = Array.isArray(rawData) ? rawData[0] : rawData;

    console.log(`📥 Data masuk dari ${deviceId}:`, data);

    // Simpan ke Database Neon
    const query = `
            INSERT INTO sensor_data (device_id, temperature, humidity, ammonia)
            VALUES ($1, $2, $3, $4)
        `;
    await pool.query(query, [
      deviceId,
      data.temperature,
      data.humidity,
      data.ammonia,
    ]);
    console.log("💾 Data berhasil disimpan ke DB");
  } catch (error) {
    console.error("❌ Error memproses data MQTT:", error);
  }
});

// =========================================
// --- 5. API ENDPOINTS (UNTUK FLUTTER) ---
// =========================================

// TEST: Cek apakah server hidup
app.get("/", (req, res) => {
  res.send("Backend Smart Kandang is RUNNING! 🚀");
});

// API: Ambil Data Sensor Terakhir (GET)
// Contoh: /api/sensor-data?id=SENSOR-A1B2C3
app.get("/api/sensor-data", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    // Ambil 20 data terakhir dari DB
    const result = await pool.query(
      "SELECT * FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 20",
      [id]
    );
    res.json(result.rows); // Kirim sebagai JSON ke Flutter
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// API: Ambil Jadwal Pakan (GET)
app.get("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    const result = await pool.query(
      "SELECT times FROM schedules WHERE device_id = $1",
      [id]
    );

    if (result.rows.length > 0) {
      res.json(result.rows[0]); // Kirim { "times": ["07:00", ...] }
    } else {
      res.json({ times: [] }); // Belum ada jadwal
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// API: Simpan Jadwal Baru (POST)
// Flutter mengirim JSON: { "times": ["08:00", "17:00"] }
app.post("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    const newSchedule = req.body; // Data dari Flutter

    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    // 1. Simpan/Update ke Database (UPSERT)
    const query = `
            INSERT INTO schedules (device_id, times) VALUES ($1, $2)
            ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()
        `;
    await pool.query(query, [id, JSON.stringify(newSchedule.times)]);

    // 2. Kirim perintah Real-time ke Alat Pakan via MQTT
    const commandTopic = `devices/${id}/commands/set_schedule`;
    mqttClient.publish(commandTopic, JSON.stringify(newSchedule));
    console.log(`📤 Perintah dikirim ke ${commandTopic}`);

    res.json({
      status: "success",
      message: "Jadwal diperbarui & dikirim ke alat",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- JALANKAN SERVER ---
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
});
