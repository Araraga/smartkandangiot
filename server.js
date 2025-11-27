// ========================================================
// Bismillah - Backend Smart Kandang Maggenzim (No Twilio)
// ========================================================

// --- 1. IMPOR LIBRARY ---
require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const cors = require("cors");

// --- 2. INISIALISASI ---
const app = express();

// Middleware (Body Parser & CORS)
app.use(cors()); // Mengizinkan akses dari aplikasi Flutter
app.use(express.json()); // Membaca body JSON (untuk jadwal dari Flutter)
app.use(express.urlencoded({ extended: true })); // Standard form parsing

// Koneksi Database (Neon PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Wajib untuk koneksi SSL ke Neon
});

// Klien MQTT (HiveMQ Cloud)
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: "mqtts", // Menggunakan koneksi aman (TLS/SSL)
  port: 8883,
});

// ========================================================
// --- 3. LOGIKA MQTT (PERANGKAT -> SERVER) ---
// ========================================================
mqttClient.on("connect", () => {
  console.log("✅ Terhubung ke HiveMQ Broker!");
  // Subscribe ke topik data dari semua perangkat (wildcard '+')
  mqttClient.subscribe("devices/+/data", (err) => {
    if (err) console.error("❌ Gagal subscribe topik MQTT:", err);
  });
});

// Fungsi ini berjalan setiap kali ada data sensor masuk
mqttClient.on("message", async (topic, message) => {
  try {
    const deviceId = topic.split("/")[1]; // Ambil ID dari topik

    // Parse data
    let rawData = JSON.parse(message.toString());
    let data;

    if (Array.isArray(rawData) && rawData.length > 0) {
      data = rawData[0]; // Ambil item pertama jika array
    } else if (typeof rawData === "object" && rawData !== null) {
      data = rawData; // Gunakan langsung jika objek
    } else {
      console.error(`⚠️ Format data dari ${deviceId} tidak dikenali.`);
      return;
    }

    // Validasi kelengkapan data
    // Kita terima 'gas_ppm' ATAU 'amonia' dari alat
    const gasValue = data.gas_ppm !== undefined ? data.gas_ppm : data.amonia;

    if (data.temperature === undefined || gasValue === undefined) {
      console.error(
        `⚠️ Data dari ${deviceId} tidak lengkap (butuh temperature & gas).`
      );
      return;
    }

    console.log(
      `📥 Menerima data dari ${deviceId}: Suhu=${data.temperature}, Gas=${gasValue}`
    );

    // 1. Simpan data ke database Neon
    // [PENTING] Kolom database menggunakan 'ammonia'
    await pool.query(
      "INSERT INTO sensor_data(device_id, temperature, humidity, ammonia) VALUES($1, $2, $3, $4)",
      [deviceId, data.temperature, data.humidity, gasValue]
    );

    // 2. Cek Log Peringatan (Hanya tampil di Console Server)
    const deviceRes = await pool.query(
      "SELECT device_name, threshold_temp, threshold_gas FROM devices WHERE device_id = $1",
      [deviceId]
    );

    if (deviceRes.rows.length > 0) {
      const device = deviceRes.rows[0];
      // Logika peringatan sederhana (hanya log)
      if (Number(data.temperature) > Number(device.threshold_temp)) {
        console.warn(
          `⚠️ ALERT: Suhu ${device.device_name} TINGGI (${data.temperature}°C)`
        );
      }
      if (Number(gasValue) > Number(device.threshold_gas)) {
        console.warn(
          `⚠️ ALERT: Gas ${device.device_name} TINGGI (${gasValue} PPM)`
        );
      }
    }
  } catch (err) {
    console.error("❌ Error memproses pesan MQTT:", err);
  }
});

// ========================================================
// --- 4. LOGIKA API (FLUTTER APP -> SERVER) ---
// ========================================================

// Root Endpoint (Tes koneksi)
app.get("/", (req, res) => {
  res.send("🚀 Backend Smart Kandang Maggenzim is RUNNING (No Twilio)!");
});

// API: Validasi Perangkat (Cek apakah ID ada di DB)
app.get("/api/check-device", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    // Ambil juga threshold untuk ditampilkan di aplikasi jika perlu
    const result = await pool.query(
      "SELECT device_id, device_name, threshold_temp, threshold_gas FROM devices WHERE device_id = $1",
      [id]
    );

    if (result.rows.length > 0) {
      // Perangkat ditemukan
      res.status(200).json({ status: "success", device: result.rows[0] });
    } else {
      // Perangkat tidak ditemukan
      res.status(404).json({ status: "error", message: "Device not found" });
    }
  } catch (err) {
    console.error("❌ Error di /api/check-device:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// API: Ambil Riwayat Data Sensor
app.get("/api/sensor-data", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    // Ambil 20 data terakhir, urutkan dari yang paling baru
    // [PENTING] Select 'ammonia' AS 'amonia' untuk frontend
    const result = await pool.query(
      "SELECT timestamp, temperature, humidity, ammonia AS amonia FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 20",
      [id]
    );
    res.json(result.rows); // Kirim list data ke Flutter
  } catch (err) {
    console.error("❌ Error di /api/sensor-data:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// API: Ambil Jadwal Pakan
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
      res.json(result.rows[0]); // Kirim: { "times": ["08:00", ...] }
    } else {
      res.json({ times: [] }); // Belum ada jadwal, kirim array kosong
    }
  } catch (err) {
    console.error("❌ Error di /api/schedule (GET):", err);
    res.status(500).json({ error: "Database error" });
  }
});

// API: Simpan/Update Jadwal Pakan
app.post("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query; // ID perangkat dari URL
    const newSchedule = req.body; // Data dari Flutter: { "times": ["08:00", ...] }

    if (!id || !newSchedule || !newSchedule.times) {
      return res.status(400).json({ error: "Data jadwal tidak lengkap" });
    }

    // 1. Simpan/Update ke Database (UPSERT)
    const query = `
      INSERT INTO schedules (device_id, times) VALUES ($1, $2)
      ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()
    `;
    await pool.query(query, [id, JSON.stringify(newSchedule.times)]);

    // 2. Kirim perintah Real-time ke Alat Pakan via MQTT
    const commandTopic = `devices/${id}/commands/set_schedule`;
    mqttClient.publish(commandTopic, JSON.stringify(newSchedule));
    console.log(`📤 Perintah update jadwal dikirim ke ${commandTopic}`);

    res.json({
      status: "success",
      message: "Jadwal berhasil disimpan dan dikirim.",
    });
  } catch (err) {
    console.error("❌ Error di /api/schedule (POST):", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================================================
// --- 5. SERVER START ---
// ========================================================

// Jalankan server pada port yang ditentukan environment atau 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server Backend berjalan di port ${PORT}`)
);
