const pool = require("../config/db");
const { formatPhoneNumber, sendWhatsappOTP } = require("../utils/whatsapp");

// --- GENERATE OTP ---
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// -------------------------------------------------------------
// 1. REQUEST OTP (Dengan Cek User Terdaftar)
// -------------------------------------------------------------
exports.requestOTP = async (req, res) => {
  const { phone } = req.body;

  try {
    if (!phone) {
      return res
        .status(400)
        .json({ status: "error", message: "Nomor HP wajib diisi" });
    }

    // 1. Format Nomor HP (08xx -> 628xx)
    const formattedPhone = formatPhoneNumber(phone);

    // --- [LOGIKA BARU] CEK APAKAH USER SUDAH ADA? ---
    // Mencegah user mendaftar ulang jika nomor sudah ada di database users
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1",
      [formattedPhone]
    );

    if (userCheck.rows.length > 0) {
      return res.status(400).json({
        status: "error",
        message: "Nomor ini sudah terdaftar. Silakan Masuk (Login).",
      });
    }
    // --------------------------------------------------

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60000); // Expire 5 menit

    // --- DEBUGGING (Opsional: Cek koneksi DB) ---
    const dbCheck = await pool.query("SELECT current_database()");
    console.log(`🔍 [DEBUG] Server DB: ${dbCheck.rows[0].current_database}`);
    // --------------------------------------------

    // 2. Bersihkan OTP lama milik nomor ini (supaya tabel tidak penuh)
    await pool.query("DELETE FROM otp_verifications WHERE phone_number = $1", [
      formattedPhone,
    ]);

    // 3. Simpan OTP Baru
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
// 2. REGISTER FINAL (Verifikasi OTP + Simpan User)
// -------------------------------------------------------------
exports.registerWithOTP = async (req, res) => {
  // Input hanya Nama, HP, dan OTP (Tanpa Password)
  const { full_name, phone, otp } = req.body;

  try {
    // Validasi Input
    if (!full_name || !phone || !otp) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Data tidak lengkap (Nama, HP, OTP wajib ada)",
        });
    }

    const formattedPhone = formatPhoneNumber(phone);

    // A. CEK VALIDITAS OTP
    // Cari di tabel otp_verifications apakah ada pasangan HP & Kode yang belum expired
    const otpCheck = await pool.query(
      "SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2 AND expires_at > NOW()",
      [formattedPhone, otp]
    );

    if (otpCheck.rows.length === 0) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Kode OTP salah atau sudah kedaluwarsa.",
        });
    }

    // B. SIMPAN USER BARU
    // Sesuai struktur tabel Anda: user_id, full_name, phone_number
    const insertUserQuery = `
      INSERT INTO users (full_name, phone_number) 
      VALUES ($1, $2) 
      RETURNING user_id, full_name, phone_number;
    `;

    const newUser = await pool.query(insertUserQuery, [
      full_name,
      formattedPhone,
    ]);

    // C. BERSIHKAN OTP BEKAS
    // Agar kode tidak bisa dipakai dua kali
    await pool.query("DELETE FROM otp_verifications WHERE phone_number = $1", [
      formattedPhone,
    ]);

    // D. SUKSES
    console.log(`🎉 User Baru Terdaftar: ${full_name} (${formattedPhone})`);

    res.status(201).json({
      status: "success",
      message: "Registrasi Berhasil!",
      user: newUser.rows[0], // Mengembalikan data user termasuk user_id ke Flutter
    });
  } catch (error) {
    console.error("❌ ERROR REGISTER:", error.message);

    // Menangani error Duplicate Key (Jika nomor HP sudah terdaftar di tabel users)
    if (error.code === "23505") {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Nomor HP ini sudah terdaftar. Silakan login.",
        });
    }

    res.status(500).json({
      status: "error",
      message: "Terjadi kesalahan server saat registrasi.",
      error: error.message,
    });
  }
};
