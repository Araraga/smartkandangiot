const { GoogleGenerativeAI } = require("@google/generative-ai");
const pool = require("../config/db");

// Inisialisasi Gemini (Pastikan API Key sudah ada di Render)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-001" });

exports.chatWithAssistant = async (req, res) => {
  const { message, device_id, user_id } = req.body;

  // 1. Validasi Input
  if (!message) {
    return res
      .status(400)
      .json({ status: "error", message: "Pesan wajib diisi." });
  }

  try {
    let sensorContext = "Tidak ada data sensor yang terlampir.";

    // --- SKENARIO A: Chat dari Detail Kandang (Ada device_id) ---
    if (device_id && device_id.trim() !== "") {
      const sensorQuery = `
        SELECT temperature, humidity, gas_ppm, timestamp 
        FROM sensor_data 
        WHERE device_id = $1 
        ORDER BY timestamp DESC LIMIT 5
      `;
      const sensorResult = await pool.query(sensorQuery, [device_id]);

      if (sensorResult.rows.length > 0) {
        sensorContext =
          `Data Spesifik Alat (${device_id}):\n` +
          JSON.stringify(sensorResult.rows, null, 2);
      }
    }

    // --- SKENARIO B: Chat dari Menu Utama (Pakai user_id) ---
    else if (user_id) {
      // Cari semua alat milik user ini
      const devicesQuery = `SELECT device_id, device_name FROM devices WHERE owned_by = $1`;
      const devicesRes = await pool.query(devicesQuery, [user_id]);

      if (devicesRes.rows.length > 0) {
        let allDevicesData = [];

        // Loop setiap alat untuk ambil data terakhir
        for (let dev of devicesRes.rows) {
          const sData = await pool.query(
            "SELECT temperature, humidity, gas_ppm FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1",
            [dev.device_id]
          );

          if (sData.rows.length > 0) {
            const d = sData.rows[0];
            allDevicesData.push(
              `- Kandang "${dev.device_name}": Suhu ${d.temperature}°C, Lembab ${d.humidity}%, Amonia ${d.gas_ppm} PPM`
            );
          } else {
            allDevicesData.push(
              `- Kandang "${dev.device_name}": Belum ada data sensor.`
            );
          }
        }
        sensorContext =
          "Rangkuman Data Semua Kandang User:\n" + allDevicesData.join("\n");
      } else {
        sensorContext = "User ini belum memiliki alat yang terdaftar.";
      }
    }

    // --- SUSUN PROMPT ---
    const prompt = `
      Anda adalah asisten ahli sistem "IoTernak".
      
      [DATA KANDANG TERKINI]
      ${sensorContext}
      
      [ACUAN STANDAR]
      - Suhu ideal: 29°C - 33°C.
      - Amonia aman: < 20 PPM.
      
      [PERTANYAAN USER]
      "${message}"
      
      [INSTRUKSI]
      1. Jawab berdasarkan data kandang di atas (jika ada).
      2. Jika ada banyak kandang, sebutkan secara spesifik mana yang aman dan mana yang bahaya.
      3. Jika tidak ada data sama sekali, jawab secara teori umum.
      4. Gunakan Bahasa Indonesia yang sopan.
    `;

    // Kirim ke AI
    const result = await model.generateContent(prompt);
    const response = await result.response;

    res.json({
      status: "success",
      reply: response.text(),
    });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ status: "error", message: "Gagal memproses AI." });
  }
};
