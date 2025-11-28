// ========================================================
// Bismillah - Backend Smart Kandang Maggenzim (Final v3)
// Fitur: Auto-Register, Ping Debug, No-Users Table
// ========================================================

// --- 1. IMPOR LIBRARY ---
require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const twilio = require("twilio");
const cors = require("cors");

// --- 2. INISIALISASI ---
const app = express();

// Middleware
app.use(cors()); // Mengizinkan akses dari Flutter
app.use(express.json()); // Membaca JSON (untuk API)
app.use(express.urlencoded({ extended: true })); // Membaca Form (untuk Webhook WA)

// Koneksi Database (Neon PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Wajib untuk Neon
});

// Klien Twilio (WhatsApp)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Klien MQTT (HiveMQ Cloud)
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: "mqtts", // SSL/TLS Secure
  port: 8883, // Port Standar MQTT Secure
});

// ========================================================
// --- 3. LOGIKA MQTT (LISTENER) ---
// ========================================================
mqttClient.on("connect", () => {
  console.log("✅ Terhubung ke HiveMQ Broker!");

  // Subscribe ke 3 Topik Utama:
  // 1. Data Sensor ("devices/SENSOR-01/data")
  // 2. Registrasi Alat ("devices/PAKAN-01/register")
  // 3. Cek Koneksi/Ping ("devices/PAKAN-01/ping")
  mqttClient.subscribe(
    ["devices/+/data", "devices/+/register", "devices/+/ping"],
    (err) => {
      if (err) console.error("❌ Gagal subscribe topik MQTT:", err);
      else console.log("📡 Listening: Data, Register, & Ping...");
    }
  );
});

mqttClient.on("message", async (topic, message) => {
  try {
    const topicParts = topic.split("/");
    const deviceId = topicParts[1]; // Ambil ID dari tengah topik
    const action = topicParts[2]; // 'data', 'register', atau 'ping'

    // --- A. LOGIKA PING (DEBUG) ---
    if (action === "ping") {
      console.log(
        `🏓 [PING] Sinyal diterima dari ${deviceId}. Jalur MQTT <-> Render SEHAT!`
      );
      return;
    }

    // --- B. LOGIKA AUTO REGISTER ---
    if (action === "register") {
      const info = JSON.parse(message.toString());
      console.log(`🆕 [REGISTER] Permintaan dari ${deviceId}:`, info);

      // Masukkan ke database (Jika ID sudah ada, biarkan/DO NOTHING)
      // Default WA kosong, User harus update nanti lewat Aplikasi
      const query = `
            INSERT INTO devices (device_id, device_name, type, whatsapp_number)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (device_id) DO NOTHING
        `;

      await pool.query(query, [
        deviceId,
        info.device_name || `Perangkat ${deviceId}`,
        info.type || "unknown",
        "", // Nomor WA dikosongkan dulu
      ]);

      console.log(`✅ [REGISTER] Perangkat ${deviceId} diproses.`);
      return;
    }

    // --- C. LOGIKA DATA SENSOR ---
    if (action === "data") {
      let rawData = JSON.parse(message.toString());
      // Handle jika data dikirim dalam array atau object tunggal
      let data = Array.isArray(rawData) ? rawData[0] : rawData;

      // Validasi data (Gas bisa bernama 'gas_ppm' atau 'amonia')
      const gasValue = data.gas_ppm !== undefined ? data.gas_ppm : data.amonia;

      if (data.temperature === undefined || gasValue === undefined) {
        console.warn(`⚠️ Data tidak lengkap dari ${deviceId}`);
        return;
      }

      console.log(
        `📥 [DATA] ${deviceId}: Suhu=${data.temperature}, Gas=${gasValue}`
      );

      // 1. Simpan Riwayat ke DB
      await pool.query(
        "INSERT INTO sensor_data(device_id, temperature, humidity, gas_ppm) VALUES($1, $2, $3, $4)",
        [deviceId, data.temperature, data.humidity, gasValue]
      );

      // 2. Cek Ambang Batas (Threshold)
      const deviceRes = await pool.query(
        "SELECT * FROM devices WHERE device_id = $1",
        [deviceId]
      );

      // Jika alat baru register tapi belum ada di cache DB lokal (rare case), skip
      if (deviceRes.rows.length === 0) return;

      const device = deviceRes.rows[0];
      let alertMessage = "";

      if (Number(data.temperature) > Number(device.threshold_temp)) {
        alertMessage = `⚠️ PERINGATAN! Suhu di ${device.device_name} panas: ${data.temperature}°C (Batas: ${device.threshold_temp}°C).`;
      } else if (Number(gasValue) > Number(device.threshold_gas)) {
        alertMessage = `⚠️ PERINGATAN! Gas amonia di ${device.device_name} tinggi: ${gasValue} PPM (Batas: ${device.threshold_gas} PPM).`;
      }

      // 3. Kirim WA (Hanya jika nomor WA sudah diisi user)
      if (
        alertMessage &&
        device.whatsapp_number &&
        device.whatsapp_number.length > 5
      ) {
        await sendWhatsApp(device.whatsapp_number, alertMessage);
      }
    }
  } catch (err) {
    console.error("❌ Error memproses pesan MQTT:", err);
  }
});

// ========================================================
// --- 4. LOGIKA WEBHOOK (WHATSAPP -> SERVER) ---
// ========================================================
app.post("/whatsapp-webhook", async (req, res) => {
  const incomingMsg = req.body.Body.toLowerCase().trim();
  const fromNumber = req.body.From; // format: whatsapp:+62...

  console.log(`💬 WA Masuk dari ${fromNumber}: ${incomingMsg}`);

  if (incomingMsg === "cek") {
    try {
      // Cari perangkat berdasarkan nomor WA pengirim
      const deviceRes = await pool.query(
        "SELECT device_id, device_name, threshold_temp, threshold_gas FROM devices WHERE whatsapp_number = $1 LIMIT 1",
        [fromNumber]
      );

      if (deviceRes.rows.length === 0) {
        await sendWhatsApp(
          fromNumber,
          "Maaf, nomor WhatsApp Anda belum terdaftar di perangkat manapun."
        );
        return res.status(200).send();
      }
      const device = deviceRes.rows[0];

      // Ambil data terakhir
      const dataRes = await pool.query(
        "SELECT * FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1",
        [device.device_id]
      );

      if (dataRes.rows.length === 0) {
        await sendWhatsApp(
          fromNumber,
          `Belum ada data sensor dari ${device.device_name}.`
        );
        return res.status(200).send();
      }

      const latestData = dataRes.rows[0];
      const suhuFormatted = Number(latestData.temperature).toFixed(1);
      const kelembabanFormatted = parseInt(latestData.humidity);
      const gasFormatted = Number(latestData.gas_ppm).toFixed(1);

      let statusMessage = "Kandang aman & terkendali.";
      if (
        Number(latestData.temperature) > Number(device.threshold_temp) ||
        Number(latestData.gas_ppm) > Number(device.threshold_gas)
      ) {
        statusMessage =
          "⚠️ PERINGATAN: Kondisi kandang TIDAK AMAN. Segera cek!";
      }

      const replyMsg = `*Laporan Kondisi Kandang*\nNama: ${device.device_name}\n\n• Suhu: ${suhuFormatted} °C\n• Lembap: ${kelembabanFormatted} %\n• Amonia: ${gasFormatted} PPM\n\n${statusMessage}`;

      await sendWhatsApp(fromNumber, replyMsg);
    } catch (err) {
      console.error("❌ Error Webhook:", err);
      await sendWhatsApp(fromNumber, "Gangguan server, coba lagi nanti.");
    }
  }

  res.status(200).send();
});

// ========================================================
// --- 5. LOGIKA API (FLUTTER APP -> SERVER) ---
// ========================================================

// 1. Cek Server Hidup
app.get("/", (req, res) => {
  res.send("🚀 Backend Smart Kandang Maggenzim is RUNNING!");
});

// 2. Cek Perangkat (Login Awal)
app.get("/api/check-device", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    const result = await pool.query(
      "SELECT device_id, device_name, threshold_temp, threshold_gas FROM devices WHERE device_id = $1",
      [id]
    );

    if (result.rows.length > 0) {
      res.status(200).json({ status: "success", device: result.rows[0] });
    } else {
      res.status(404).json({ status: "error", message: "Device not found" });
    }
  } catch (err) {
    console.error("❌ Error /api/check-device:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// 3. Ambil Riwayat Data Sensor (Grafik)
app.get("/api/sensor-data", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    const result = await pool.query(
      "SELECT timestamp, temperature, humidity, gas_ppm AS amonia FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 20",
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error /api/sensor-data:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// 4. Ambil Jadwal Pakan
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
      res.json(result.rows[0]);
    } else {
      res.json({ times: [] });
    }
  } catch (err) {
    console.error("❌ Error /api/schedule:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// 5. Simpan & Kirim Jadwal Pakan
app.post("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    const newSchedule = req.body; // { "times": ["08:00", "16:00"] }

    if (!id || !newSchedule || !newSchedule.times) {
      return res.status(400).json({ error: "Data jadwal tidak lengkap" });
    }

    // A. Simpan ke Database (Update jika ada, Insert jika belum)
    const query = `
      INSERT INTO schedules (device_id, times) VALUES ($1, $2)
      ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()
    `;
    await pool.query(query, [id, JSON.stringify(newSchedule.times)]);

    // B. Kirim ke Alat via MQTT
    const commandTopic = `devices/${id}/commands/set_schedule`;

    // Kirim perintah ke alat (biasanya command tidak perlu retain, tapi untuk jadwal boleh retain jika mau)
    // Di sini kita pakai standar publish agar real-time
    mqttClient.publish(commandTopic, JSON.stringify(newSchedule));

    console.log(`📤 [JADWAL] Terkirim ke ${commandTopic}`);

    res.json({
      status: "success",
      message: "Jadwal berhasil disimpan & dikirim.",
    });
  } catch (err) {
    console.error("❌ Error /api/schedule (POST):", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================================================
// --- 6. FUNGSI BANTUAN ---
// ========================================================
async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
    });
    console.log(`✅ Pesan WA terkirim ke ${to}`);
  } catch (err) {
    console.error(`❌ Gagal kirim WA ke ${to}:`, err.message);
  }
}

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server Backend berjalan di port ${PORT}`)
);
