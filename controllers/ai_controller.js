const { GoogleGenerativeAI } = require("@google/generative-ai");
const pool = require("../config/db");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

exports.chatWithAssistant = async (req, res) => {
  const { message, device_id } = req.body;

  if (!message) {
    return res.status(400).json({
      status: "error",
      message: "Pesan tidak boleh kosong.",
    });
  }

  try {
    let sensorContext = "Data sensor tidak dilampirkan (Pertanyaan Umum).";

    if (device_id && device_id.trim() !== "") {
      const sensorQuery = `
        SELECT temperature, humidity, gas_ppm, timestamp 
        FROM sensor_data 
        WHERE device_id = $1 
        ORDER BY timestamp DESC LIMIT 5
      `;
      const sensorResult = await pool.query(sensorQuery, [device_id]);

      if (sensorResult.rows.length > 0) {
        sensorContext = JSON.stringify(sensorResult.rows, null, 2);
      } else {
        sensorContext = "Data sensor kosong/belum ada untuk alat ini.";
      }
    }

    const prompt = `
      Anda adalah asisten cerdas sistem "IoTernak" (Monitoring Kandang Ayam).
      
      [KONTEKS DATA SENSOR]
      Device ID: ${device_id || "Tidak Spesifik"}
      Data:
      ${sensorContext}
      
      [STANDAR KESELAMATAN AYAM]
      - Suhu ideal: 29°C - 33°C.
      - Amonia aman: Di bawah 20 PPM.
      
      [PERTANYAAN USER]
      "${message}"
      
      [INSTRUKSI]
      1. Jika ada data sensor, analisis kondisinya (Aman/Bahaya).
      2. Jika TIDAK ada data sensor, jawab sebagai pertanyaan pengetahuan umum tentang peternakan.
      3. Gunakan Bahasa Indonesia yang sopan dan ringkas.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const aiText = response.text();

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
