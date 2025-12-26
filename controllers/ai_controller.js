const { GoogleGenerativeAI } = require("@google/generative-ai");
const pool = require("../config/db"); // Import koneksi database yang kita buat di langkah 2

// Inisialisasi Google Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

exports.chatWithAssistant = async (req, res) => {
  const { message, device_id } = req.body;

  // 1. Validasi Input
  if (!message || !device_id) {
    return res.status(400).json({
      status: "error",
      message: "Data kurang: message dan device_id wajib ada.",
    });
  }

  try {
    // 2. RETRIEVAL: Ambil 5 data sensor terakhir dari Database
    const sensorQuery = `
      SELECT temperature, humidity, gas_ppm, timestamp 
      FROM sensor_data 
      WHERE device_id = $1 
      ORDER BY timestamp DESC LIMIT 5
    `;
    const sensorResult = await pool.query(sensorQuery, [device_id]);

    // Format data menjadi string JSON
    let sensorContext = "Data sensor tidak tersedia.";
    if (sensorResult.rows.length > 0) {
      sensorContext = JSON.stringify(sensorResult.rows, null, 2);
    }

    // 3. AUGMENTATION: Susun Prompt untuk AI
    const prompt = `
      Anda adalah asisten cerdas sistem "IoTernak" (Monitoring Kandang Ayam).
      
      [KONTEKS DATA SENSOR TERKINI]
      Device ID: ${device_id}
      Data Terakhir:
      ${sensorContext}
      
      [STANDAR KESELAMATAN AYAM]
      - Suhu ideal: 29°C - 33°C.
      - Amonia aman: Di bawah 20 PPM.
      
      [PERTANYAAN USER]
      "${message}"
      
      [INSTRUKSI]
      1. Analisis data sensor di atas (Apakah kondisi Aman/Bahaya?).
      2. Jawab pertanyaan user berdasarkan fakta data sensor.
      3. Jika parameter berbahaya, berikan solusi singkat.
      4. Gunakan Bahasa Indonesia yang sopan.
    `;

    // 4. GENERATION: Kirim ke Google Gemini
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const aiText = response.text();

    // 5. Kirim Balasan ke Frontend
    res.json({
      status: "success",
      reply: aiText,
    });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({
      status: "error",
      message: "Maaf, asisten sedang sibuk.",
    });
  }
};
