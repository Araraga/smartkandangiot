const pool = require("../config/db");
const bcrypt = require("bcrypt");
const { formatPhoneNumber, sendWhatsappOTP } = require("../utils/whatsapp");

// --- TAHAP 1: Request OTP (User Masukkan Nomor HP) ---
exports.requestOTP = async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res
      .status(400)
      .json({ status: "error", message: "Nomor HP wajib diisi." });
  }

  // Format nomor jadi 628xxx
  const formattedPhone = formatPhoneNumber(phone);

  try {
    // 1. Cek apakah nomor sudah dipakai user lain?
    const userCheck = await pool.query(
      "SELECT id FROM users WHERE phone_number = $1",
      [formattedPhone]
    );
    if (userCheck.rows.length > 0) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Nomor HP ini sudah terdaftar. Silakan login.",
        });
    }

    // 2. Generate Kode OTP 6 Angka (Contoh: 123456)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 3. Simpan ke Tabel OTP (Hapus dulu OTP lama biar tidak numpuk)
    await pool.query("DELETE FROM otp_verifications WHERE phone_number = $1", [
      formattedPhone,
    ]);

    // Set kadaluarsa 5 menit dari sekarang
    const expiresAt = new Date(Date.now() + 5 * 60000);

    await pool.query(
      "INSERT INTO otp_verifications (phone_number, otp_code, expires_at) VALUES ($1, $2, $3)",
      [formattedPhone, otp, expiresAt]
    );

    // 4. Kirim WA via Fonnte
    const isSent = await sendWhatsappOTP(formattedPhone, otp);

    if (isSent) {
      res.json({
        status: "success",
        message: "Kode OTP berhasil dikirim ke WhatsApp Anda.",
      });
    } else {
      res.status(500).json({
        status: "error",
        message: "Gagal mengirim WhatsApp. Pastikan nomor benar/aktif.",
      });
    }
  } catch (error) {
    console.error("Error Request OTP:", error);
    res
      .status(500)
      .json({ status: "error", message: "Terjadi kesalahan server." });
  }
};

// --- TAHAP 2: Register Final (User Masukkan Data + OTP) ---
exports.registerWithOTP = async (req, res) => {
  const { full_name, phone, password, otp_code } = req.body;

  if (!full_name || !phone || !password || !otp_code) {
    return res
      .status(400)
      .json({
        status: "error",
        message: "Data tidak lengkap (Nama, HP, Password, OTP wajib).",
      });
  }

  const formattedPhone = formatPhoneNumber(phone);

  try {
    // 1. Cek apakah Kode OTP Benar & Ada di Database?
    const otpCheck = await pool.query(
      "SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp_code = $2",
      [formattedPhone, otp_code]
    );

    if (otpCheck.rows.length === 0) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Kode OTP salah atau tidak ditemukan.",
        });
    }

    // 2. Cek apakah OTP sudah kadaluarsa?
    const otpData = otpCheck.rows[0];
    if (new Date() > new Date(otpData.expires_at)) {
      return res
        .status(400)
        .json({
          status: "error",
          message: "Kode OTP sudah kadaluarsa. Minta kode baru.",
        });
    }

    // 3. JIKA VALID -> Buat User Baru di Tabel Users
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await pool.query(
      "INSERT INTO users (full_name, phone_number, password, role) VALUES ($1, $2, $3, 'user') RETURNING id, full_name, phone_number",
      [full_name, formattedPhone, hashedPassword]
    );

    // 4. Bersihkan OTP bekas pakai
    await pool.query("DELETE FROM otp_verifications WHERE phone_number = $1", [
      formattedPhone,
    ]);

    res.status(201).json({
      status: "success",
      message: "Registrasi berhasil! Akun Anda telah aktif.",
      data: newUser.rows[0],
    });
  } catch (error) {
    console.error("Error Register:", error);
    res
      .status(500)
      .json({ status: "error", message: "Gagal membuat akun user." });
  }
};
