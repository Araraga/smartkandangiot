const pool = require("../config/db");
const { formatPhoneNumber, sendWhatsappOTP } = require("../utils/whatsapp");

// --- GENERATE OTP ---
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

exports.requestOTP = async (req, res) => {
  const { phone } = req.body;

  try {
    if (!phone)
      return res
        .status(400)
        .json({ status: "error", message: "Nomor HP wajib diisi" });

    // 1. Format Nomor HP
    const formattedPhone = formatPhoneNumber(phone);
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60000); // Expire 5 menit

    // --- DEBUGGING (MATA-MATA) ---
    // Kita cek server ini sebenarnya konek ke database mana
    const dbCheck = await pool.query("SELECT current_database()");
    console.log(
      `🔍 [DEBUG] Server sedang menggunakan Database: ${dbCheck.rows[0].current_database}`
    );
    // -----------------------------

    // 2. Simpan ke Database
    // PERHATIKAN: Di sini saya pakai 'otp_code', bukan 'otp'
    const query = `
      INSERT INTO otp_verifications (phone_number, otp_code, expires_at)
      VALUES ($1, $2, $3)
      RETURNING id;
    `;

    await pool.query(query, [formattedPhone, otp, expiresAt]);
    console.log(`✅ OTP ${otp} berhasil disimpan untuk ${formattedPhone}`);

    // 3. Kirim WA
    const isSent = await sendWhatsappOTP(formattedPhone, otp);

    if (isSent) {
      res.json({ status: "success", message: "OTP terkirim ke WhatsApp!" });
    } else {
      res
        .status(500)
        .json({
          status: "error",
          message: "Gagal kirim WA (Cek Token Fonnte)",
        });
    }
  } catch (error) {
    console.error("❌ ERROR DI REQUEST-OTP:", error.message);

    // Deteksi Error Kolom
    if (error.code === "42703") {
      console.error(
        "⚠️ PETUNJUK: Error 42703 artinya NAMA KOLOM SALAH. Pastikan di kodingan 'otp_code' dan di DB juga 'otp_code'."
      );
    }

    res
      .status(500)
      .json({
        status: "error",
        message: "Terjadi kesalahan server.",
        error: error.message,
      });
  }
};

// Fungsi Register (Placeholder sementara biar tidak error saat dipanggil routes)
exports.registerWithOTP = async (req, res) => {
  res.json({ message: "Register function belum diaktifkan saat testing OTP" });
};
