const { GoogleGenerativeAI } = require("@google/generative-ai");
const pool = require("../config/db");

// Inisialisasi Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-001" });

exports.chatWithAssistant = async (req, res) => {
  const { message, device_id, user_id } = req.body;

  if (!message) {
    return res
      .status(400)
      .json({ status: "error", message: "Pesan wajib diisi." });
  }

  try {
    let sensorContext = "Tidak ada data sensor yang terlampir.";

    // --- Ambil Data Sensor (Logic sama seperti sebelumnya) ---
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
    } else if (user_id) {
      const devicesQuery = `SELECT device_id, device_name FROM devices WHERE owned_by = $1`;
      const devicesRes = await pool.query(devicesQuery, [user_id]);

      if (devicesRes.rows.length > 0) {
        let allDevicesData = [];
        for (let dev of devicesRes.rows) {
          const sData = await pool.query(
            "SELECT temperature, humidity, gas_ppm FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1",
            [dev.device_id]
          );

          if (sData.rows.length > 0) {
            const d = sData.rows[0];
            allDevicesData.push(
              `- ${dev.device_name}: Suhu ${d.temperature}C, Lembab ${d.humidity}%, Amonia ${d.gas_ppm} PPM`
            );
          } else {
            allDevicesData.push(`- ${dev.device_name}: Belum ada data.`);
          }
        }
        sensorContext =
          "Rangkuman Data Semua Kandang:\n" + allDevicesData.join("\n");
      }
    }

    // --- PROMPT BARU (ANTI BOLD & SINGKAT) ---
    const prompt = `
      Anda adalah asisten sistem "IoTernak".
      
      DATA KANDANG:
      ${sensorContext}
      
      STANDAR: Suhu 29-33C, Amonia <20 PPM.
      
      PERTANYAAN USER: "${message}"
      
      INSTRUKSI PENTING:
      1. Jawab dengan SINGKAT, PADAT, dan JELAS.
      2. JANGAN gunakan format bold (**tebal**), italic, atau markdown apapun. Gunakan teks biasa.
      3. Langsung ke inti masalah. Tidak perlu basa-basi berlebihan.
      4. Jika data bahaya, beri peringatan tegas.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    res.json({
      status: "success",
      reply: response.text(), // Mengirim teks polos
    });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ status: "error", message: "Gagal memproses AI." });
  }
};
