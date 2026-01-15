const pool = require("../config/db");
const { formatPhoneNumber, sendWhatsappOTP } = require("../utils/whatsapp");

// --- GENERATE OTP ---
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// -------------------------------------------------------------
// 1. REQUEST OTP (UPDATE: CEK SUPER KETAT)
// -------------------------------------------------------------
exports.requestOTP = async (req, res) => {
  const { phone } = req.body;

  try {
    if (!phone) {
      return res
        .status(400)
        .json({ status: "error", message: "Nomor HP wajib diisi" });
    }

    // 1. Siapkan 2 Versi Nomor (Format 62 dan Format 08)
    const formattedPhone = formatPhoneNumber(phone); // Contoh: 628123...

    // Kita buat versi original (jaga-jaga kalau user input 08...)
    // Atau jika database Anda menyimpan '08', kita pastikan inputan user yg '08' juga dicek
    const originalPhone = phone.startsWith("0") ? phone : "0" + phone;

    console.log(`🔍 [DEBUG] Cek User: ${formattedPhone} ATAU ${phone}`);

    // --- [UPDATE PENTING] CEK KEDUA FORMAT ---
    // Query ini akan mencari apakah nomor HP ada sebagai '628...' ATAU '08...'
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1 OR phone_number = $2",
      [formattedPhone, phone]
    );

    if (userCheck.rows.length > 0) {
      console.log(
        `⛔ [BLOCKED] Nomor ${phone} sudah terdaftar sebagai ID: ${userCheck.rows[0].user_id}`
      );
      return res.status(400).json({
        status: "error",
        message: "Nomor ini sudah terdaftar. Silakan Masuk (Login).",
      });
    }
    // --------------------------------------------------

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60000); // 5 menit

    // 2. Bersihkan OTP lama (Cek kedua format juga biar bersih total)
    await pool.query(
      "DELETE FROM otp_verifications WHERE phone_number = $1 OR phone_number = $2",
      [formattedPhone, phone]
    );

    // 3. Simpan OTP Baru (Simpan dengan format standar 62 agar rapi)
    const query = `
      INSERT INTO otp_verifications (phone_number, otp_code, expires_at)
      VALUES ($1, $2, $3)
    `;
    await pool.query(query, [formattedPhone, otp, expiresAt]);
    console.log(`✅ OTP ${otp} disimpan untuk ${formattedPhone}`);

    // 4. Kirim WA
    const isSent = await sendWhatsappOTP(formattedPhone, otp);

    if (isSent) {
      res.json({ status: "success", message: "OTP terkirim ke WhatsApp!" });
    } else {
      res.status(500).json({
        status: "error",
        message: "Gagal kirim WA (Cek Token Fonnte)",
      });
    }
  } catch (error) {
    console.error("❌ ERROR REQUEST-OTP:", error.message);
    res.status(500).json({
      status: "error",
      message: "Terjadi kesalahan server.",
      error: error.message,
    });
  }
};

// -------------------------------------------------------------
// 2. REGISTER FINAL
// -------------------------------------------------------------
exports.registerWithOTP = async (req, res) => {
  const { full_name, phone, otp } = req.body;

  try {
    if (!full_name || !phone || !otp) {
      return res
        .status(400)
        .json({ status: "error", message: "Data tidak lengkap" });
    }

    const formattedPhone = formatPhoneNumber(phone);

    // A. CEK OTP
    // Cek apakah OTP cocok untuk nomor format 62 ATAU format input user
    const otpCheck = await pool.query(
      "SELECT * FROM otp_verifications WHERE (phone_number = $1 OR phone_number = $2) AND otp_code = $3 AND expires_at > NOW()",
      [formattedPhone, phone, otp]
    );

    if (otpCheck.rows.length === 0) {
      return res
        .status(400)
        .json({ status: "error", message: "Kode OTP salah atau kedaluwarsa." });
    }

    // B. SIMPAN USER (Kita simpan format 62 agar standar ke depannya)
    const insertUserQuery = `
      INSERT INTO users (full_name, phone_number) 
      VALUES ($1, $2) 
      RETURNING user_id, full_name, phone_number;
    `;

    const newUser = await pool.query(insertUserQuery, [
      full_name,
      formattedPhone,
    ]);

    // C. BERSIHKAN OTP
    await pool.query(
      "DELETE FROM otp_verifications WHERE phone_number = $1 OR phone_number = $2",
      [formattedPhone, phone]
    );

    console.log(`🎉 User Baru Terdaftar: ${full_name}`);

    res.status(201).json({
      status: "success",
      message: "Registrasi Berhasil!",
      user: newUser.rows[0],
    });
  } catch (error) {
    console.error("❌ ERROR REGISTER:", error.message);
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ status: "error", message: "Nomor HP ini sudah terdaftar." });
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
