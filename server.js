// server.js - Backend Server (Render Ready)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// ═══════════════════════════════════════════════════════════
//  ⚙️ CORS - מאפשר גישה מדף הנחיתה
// ═══════════════════════════════════════════════════════════
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ═══════════════════════════════════════════════════════════
//  🔗 MongoDB Atlas Connection
// ═══════════════════════════════════════════════════════════
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rebarcalc';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Handle connection errors after initial connection
mongoose.connection.on('error', err => {
  console.error('MongoDB error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected. Attempting reconnect...');
});

// ═══════════════════════════════════════════════════════════
//  📊 Schema - License
// ═══════════════════════════════════════════════════════════

const LicenseSchema = new mongoose.Schema({
  // Email = המפתח!
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    index: true
  },
  
  // פרטי תשלום PayPal
  paymentId: String,
  transactionId: String,
  amount: Number,
  currency: String,
  
  // מכשירים (מקסימום 2)
  devices: [{
    deviceId: {
      type: String,
      required: true
    },
    deviceType: {
      type: String,
      required: true
    },
    deviceInfo: {
      manufacturer: String,
      model: String,
      hostname: String,
      platform: String
    },
    activatedAt: {
      type: Date,
      default: Date.now
    },
    lastSeenAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  maxDevices: {
    type: Number,
    default: 2
  },
  
  status: {
    type: String,
    enum: ['active', 'expired', 'revoked'],
    default: 'active'
  },
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    default: () => new Date('2099-12-31')
  }
});

const License = mongoose.model('License', LicenseSchema);

// ═══════════════════════════════════════════════════════════
//  🏥 Health Check (Render uses this to monitor your service)
// ═══════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Rebar List PRO - License Server',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({ 
    status: dbState === 1 ? 'healthy' : 'unhealthy',
    database: states[dbState] || 'unknown'
  });
});

// ═══════════════════════════════════════════════════════════
//  🎫 API Endpoints
// ═══════════════════════════════════════════════════════════

// 1️⃣ Webhook מ-PayPal (אחרי תשלום)
app.post('/api/webhook/paypal', async (req, res) => {
  try {
    const { event_type, resource } = req.body;
    
    if (event_type === 'PAYMENT.SALE.COMPLETED') {
      const { id, amount, payer } = resource;
      const email = payer.payer_info.email.toLowerCase();
      
      console.log('💰 Payment received:', email, amount.total, amount.currency);
      
      let license = await License.findOne({ email });
      
      if (license) {
        console.log('ℹ️ License already exists for:', email);
        return res.json({ success: true, message: 'License already exists' });
      }
      
      license = new License({
        email: email,
        paymentId: id,
        transactionId: id,
        amount: parseFloat(amount.total),
        currency: amount.currency,
        devices: [],
        maxDevices: 2,
        status: 'active'
      });
      
      await license.save();
      console.log('✅ License created for:', email);
      
      res.json({ success: true, message: 'License created' });
    } else {
      res.json({ success: true, message: 'Event ignored' });
    }
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2️⃣ בדיקה אוטומטית (בטעינת אפליקציה)
app.post('/api/license/check-auto', async (req, res) => {
  try {
    const { deviceId, deviceType } = req.body;
    
    console.log('🔍 Check license:', deviceType, deviceId.slice(0, 16) + '...');
    
    const license = await License.findOne({
      status: 'active',
      'devices.deviceId': deviceId
    });
    
    if (license && license.expiresAt > new Date()) {
      await License.updateOne(
        { _id: license._id, 'devices.deviceId': deviceId },
        { $set: { 'devices.$.lastSeenAt': new Date() } }
      );
      
      const deviceIndex = license.devices.findIndex(d => d.deviceId === deviceId);
      
      console.log('✅ Valid license found:', license.email, `(${deviceIndex + 1}/${license.maxDevices})`);
      
      res.json({
        valid: true,
        email: license.email,
        slot: deviceIndex + 1,
        maxSlots: license.maxDevices,
        expiresAt: license.expiresAt
      });
    } else {
      console.log('❌ No license found for device:', deviceId.slice(0, 16) + '...');
      res.json({ valid: false });
    }
  } catch (error) {
    console.error('Error checking license:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3️⃣ הפעלת רישיון (עם Email)
app.post('/api/license/activate-auto', async (req, res) => {
  try {
    const { email, deviceId, deviceType, deviceInfo } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    
    console.log('🔓 Activate license:', normalizedEmail, deviceType);
    
    const license = await License.findOne({
      email: normalizedEmail,
      status: 'active'
    });
    
    if (!license) {
      console.log('❌ License not found for:', normalizedEmail);
      return res.json({
        success: false,
        message: 'לא נמצא רישיון לכתובת מייל זו. אנא רכוש רישיון תחילה.'
      });
    }
    
    const existingDevice = license.devices.find(d => d.deviceId === deviceId);
    if (existingDevice) {
      existingDevice.lastSeenAt = new Date();
      await license.save();
      
      const deviceIndex = license.devices.indexOf(existingDevice);
      
      console.log('ℹ️ Device already registered:', deviceType, `(${deviceIndex + 1}/${license.maxDevices})`);
      
      return res.json({
        success: true,
        message: `המכשיר כבר רשום (${deviceIndex + 1}/${license.maxDevices})`,
        slot: deviceIndex + 1,
        maxSlots: license.maxDevices
      });
    }
    
    if (license.devices.length >= license.maxDevices) {
      console.log('❌ License full:', normalizedEmail, `(${license.devices.length}/${license.maxDevices})`);
      
      return res.json({
        success: false,
        message: `הרישיון מלא (${license.maxDevices}/${license.maxDevices} מכשירים).\nנתק מכשיר אחד כדי להוסיף מכשיר חדש.`
      });
    }
    
    license.devices.push({
      deviceId,
      deviceType,
      deviceInfo: deviceInfo || {},
      activatedAt: new Date(),
      lastSeenAt: new Date()
    });
    
    await license.save();
    
    console.log('✅ Device activated:', normalizedEmail, deviceType, `(${license.devices.length}/${license.maxDevices})`);
    
    res.json({
      success: true,
      message: `הרישיון הופעל בהצלחה! (מכשיר ${license.devices.length}/${license.maxDevices})`,
      slot: license.devices.length,
      maxSlots: license.maxDevices
    });
    
  } catch (error) {
    console.error('Error activating license:', error);
    res.status(500).json({
      success: false,
      message: 'שגיאת שרת: ' + error.message
    });
  }
});

// 4️⃣ ניתוק מכשיר
app.post('/api/license/disconnect-device', async (req, res) => {
  try {
    const { email, deviceId } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    
    const license = await License.findOne({
      email: normalizedEmail,
      status: 'active'
    });
    
    if (!license) {
      return res.json({ success: false, message: 'רישיון לא נמצא' });
    }
    
    const initialLength = license.devices.length;
    license.devices = license.devices.filter(d => d.deviceId !== deviceId);
    
    if (license.devices.length < initialLength) {
      await license.save();
      console.log('✅ Device disconnected:', normalizedEmail, deviceId.slice(0, 16) + '...');
      
      res.json({
        success: true,
        message: `המכשיר נותק בהצלחה (${license.devices.length}/${license.maxDevices})`
      });
    } else {
      res.json({ success: false, message: 'המכשיר לא נמצא' });
    }
  } catch (error) {
    console.error('Error disconnecting device:', error);
    res.status(500).json({ success: false, message: 'שגיאת שרת' });
  }
});

// 5️⃣ רשימת מכשירים
app.post('/api/license/list-devices', async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    
    const license = await License.findOne({
      email: normalizedEmail,
      status: 'active'
    });
    
    if (!license) {
      return res.json({ success: false, message: 'רישיון לא נמצא' });
    }
    
    const devices = license.devices.map((d, index) => ({
      slot: index + 1,
      type: d.deviceType,
      manufacturer: d.deviceInfo?.manufacturer || 'Unknown',
      model: d.deviceInfo?.model || 'Unknown',
      hostname: d.deviceInfo?.hostname || 'Unknown',
      activatedAt: d.activatedAt,
      lastSeenAt: d.lastSeenAt
    }));
    
    res.json({
      success: true,
      devices,
      maxDevices: license.maxDevices
    });
    
  } catch (error) {
    console.error('Error listing devices:', error);
    res.status(500).json({ success: false, message: 'שגיאת שרת' });
  }
});

// ═══════════════════════════════════════════════════════════
//  🚀 Start Server
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
});
