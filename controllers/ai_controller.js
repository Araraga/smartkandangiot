const { GoogleGenerativeAI } = require("@google/generative-ai");
const pool = require("../config/db");

// Inisialisasi Google Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Menggunakan model flash yang cepat dan efisien untuk chat
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

exports.chatWithAssistant = async (req, res) => {
  const { message, device_id, user_id } = req.body;

  // Validasi input pesan
  if (!message) {
    return res
      .status(400)
      .json({
        status: "error",
        message: "Pesan wajib diisi untuk bertanya pada Prof. Jago.",
      });
  }

  try {
    // --- 1. PENGUMPULAN KONTEKS DATA SENSOR ---

    let sensorContext =
      "Saat ini tidak ada data sensor spesifik yang terlampir.";

    // Skenario A: Jika user sedang melihat detail satu alat (ada device_id)
    if (device_id && device_id.trim() !== "") {
      const sensorQuery = `
        SELECT temperature, humidity, gas_ppm, timestamp 
        FROM sensor_data 
        WHERE device_id = $1 
        ORDER BY timestamp DESC LIMIT 5
      `;
      const sensorResult = await pool.query(sensorQuery, [device_id]);

      if (sensorResult.rows.length > 0) {
        const latest = sensorResult.rows[0];
        // Kita format datanya jadi kalimat agar AI lebih mudah mengerti konteksnya
        sensorContext = `Data Kondisi Kandang Terkini (ID Alat: ${device_id}): 
        - Suhu: ${latest.temperature}°C 
        - Kelembapan: ${latest.humidity}% 
        - Kadar Amonia: ${latest.gas_ppm} PPM. 
        (Data historis 5 pembacaan terakhir tersedia di database untuk analisis tren).`;
      }
    }
    // Skenario B: Jika user di halaman dashboard utama (hanya ada user_id)
    else if (user_id) {
      // Ambil semua alat milik user
      const devicesQuery = `SELECT device_id, device_name FROM devices WHERE owned_by = $1`;
      const devicesRes = await pool.query(devicesQuery, [user_id]);

      if (devicesRes.rows.length > 0) {
        let allDevicesData = [];

        // Loop setiap device untuk ambil data terakhirnya
        for (let dev of devicesRes.rows) {
          const sData = await pool.query(
            "SELECT temperature, humidity, gas_ppm FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1",
            [dev.device_id]
          );

          if (sData.rows.length > 0) {
            const d = sData.rows[0];
            allDevicesData.push(
              `- Kandang ${dev.device_name}: Suhu ${d.temperature}°C, Lembab ${d.humidity}%, Amonia ${d.gas_ppm} PPM`
            );
          } else {
            allDevicesData.push(
              `- Kandang ${dev.device_name}: Belum ada data sensor masuk.`
            );
          }
        }
        sensorContext =
          "Rangkuman Kondisi Semua Kandang Milik Peternak:\n" +
          allDevicesData.join("\n");
      }
    }

    // --- 2. PENYUSUNAN PROMPT PROF. JAGO ---

    const prompt = `
      PERAN ANDA:
      Nama Anda adalah "Prof. Jago". Anda adalah asisten ahli AI dari sistem IoTernak.
      Karakteristik Anda: Sangat cerdas, berwawasan luas tentang peternakan ayam, namun memiliki kepribadian yang ramah, hangat, dan "friendly". Anda senang membimbing peternak agar sukses.

      KONTEKS DATA SENSOR:
      ${sensorContext}

      STANDAR KESEHATAN AYAM (ACUAN): 
      - Suhu Ideal: 29°C sampai 33°C.
      - Amonia Aman: Di bawah 20 PPM.
      - Kelembapan Ideal: 50% sampai 70%.

      PERTANYAAN DARI PETERNAK: "${message}"

      INSTRUKSI PENTING (WAJIB DIPATUHI):
      1. Gaya Bahasa: Gunakan bahasa Indonesia yang luwes, sopan, dan akrab. Hindari bahasa yang terlalu kaku atau robotik. Sapa user sesekali jika perlu.
      2. Kedalaman Jawaban: Berikan jawaban yang cukup panjang dan informatif. Jangan hanya menjawab "Ya" atau "Tidak". Jelaskan alasannya ("mengapa") dan berikan saran praktis ("bagaimana").
      3. Format Teks (STRICT): 
         - DILARANG KERAS menggunakan format Markdown (seperti bold, italic, heading).
         - JANGAN gunakan tanda bintang dua (**tebal**).
         - JANGAN gunakan tanda pagar (#).
         - Tuliskan semuanya dalam teks biasa (plain text).
      4. List/Daftar: Jika perlu membuat daftar poin, gunakan tanda strip (-) di awal baris. Jangan gunakan angka 1. 2. 3.
      5. Analisis Bahaya: Jika melihat data sensor di atas batas wajar (misal amonia tinggi), berikan peringatan dengan nada peduli dan solusi segera.

      Silakan berikan jawaban terbaik Anda sebagai Prof. Jago:
    `;

    // --- 3. EKSEKUSI AI ---

    const result = await model.generateContent(prompt);
    const response = await result.response;

    // PEMBERSIHAN OUTPUT (Safety Net)
    // Menghapus simbol markdown jika AI tidak sengaja mengeluarkannya
    let cleanText = response
      .text()
      .replace(/\*\*/g, "") // Hapus bold
      .replace(/\*/g, "") // Hapus italic
      .replace(/#/g, "") // Hapus header
      .replace(/`/g, "") // Hapus backtick
      .replace(/\[/g, "") // Hapus kurung siku markdown
      .replace(/\]/g, "");

    res.json({
      status: "success",
      reply: cleanText,
    });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({
      status: "error",
      message:
        "Waduh, koneksi Prof. Jago sedang terganggu. Silakan coba sesaat lagi ya.",
    });
  }
};
