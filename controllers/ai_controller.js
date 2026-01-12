const { GoogleGenerativeAI } = require("@google/generative-ai");
const pool = require("../config/db");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

exports.chatWithAssistant = async (req, res) => {
  const { message, device_id, user_id } = req.body;

  if (!message) {
    return res.status(400).json({
      status: "error",
      message: "Pesan wajib diisi untuk bertanya pada Prof. Jago.",
    });
  }

  try {
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
        sensorContext = `Data Kondisi Kandang Terkini (ID Alat: ${device_id}): 
        - Suhu: ${latest.temperature}°C 
        - Kelembapan: ${latest.humidity}% 
        - Kadar Amonia: ${latest.gas_ppm} PPM.`;
      }
    }
    // Skenario B: Jika user di halaman dashboard utama (hanya ada user_id)
    else if (user_id) {
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
              `- Kandang ${dev.device_name}: Suhu ${d.temperature}°C, Lembab ${d.humidity}%, Amonia ${d.gas_ppm} PPM`
            );
          } else {
            allDevicesData.push(
              `- Kandang ${dev.device_name}: Belum ada data.`
            );
          }
        }
        sensorContext =
          "Rangkuman Data Semua Kandang:\n" + allDevicesData.join("\n");
      }
    }

    // --- 2. PENYUSUNAN PROMPT PROF. JAGO (DIREVISI) ---

    const prompt = `
      PERAN ANDA:
      Nama Anda adalah "Prof. Jago", asisten AI IoTernak yang cerdas dan ramah.

      KONTEKS DATA SENSOR:
      ${sensorContext}

      STANDAR ACUAN: 
      - Suhu Ideal: 29°C - 33°C.
      - Amonia Aman: < 20 PPM.
      - Kelembapan Ideal: 50% - 70%.

      PERTANYAAN USER: "${message}"

      INSTRUKSI PENTING (STRICT):
      1. FOKUS PADA PERTANYAAN: Jawablah HANYA apa yang ditanyakan user. Jangan melebar membahas hal lain yang tidak relevan dengan pertanyaan.
      2. GAYA BAHASA: Gunakan bahasa Indonesia yang luwes, enak dibaca, dan "friendly" (seperti rekan kerja yang membantu). Hindari bahasa kaku.
      3. PANJANG JAWABAN: Buat jawaban yang "PAS". 
         - Jangan terlalu singkat (jangan cuma "Ya/Tidak").
         - Jangan bertele-tele (jangan memberikan kuliah panjang lebar).
         - Cukup berikan info inti + sedikit penjelasan pendukung jika perlu.
      4. FORMAT TEXT (WAJIB): 
         - DILARANG menggunakan Markdown (No bold, No italic, No heading). Gunakan teks biasa.
         - Jika butuh poin-poin, gunakan tanda strip (-) saja.

      Silakan jawab sebagai Prof. Jago:
    `;

    // --- 3. EKSEKUSI AI ---

    const result = await model.generateContent(prompt);
    const response = await result.response;

    // PEMBERSIHAN OUTPUT (Safety Net)
    let cleanText = response
      .text()
      .replace(/\*\*/g, "") // Hapus bold
      .replace(/\*/g, "") // Hapus italic
      .replace(/#/g, "") // Hapus header
      .replace(/`/g, "") // Hapus code block
      .replace(/\[/g, "")
      .replace(/\]/g, "");

    res.json({
      status: "success",
      reply: cleanText,
    });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({
      status: "error",
      message: "Prof. Jago sedang gangguan sesaat. Coba lagi nanti ya.",
    });
  }
};
