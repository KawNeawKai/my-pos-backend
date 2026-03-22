// โหลดตัวแปรตั้งค่าจากไฟล์ .env (เช่น รหัสผ่านต่างๆ)
require('dotenv').config();

// นำเข้า Library ที่จำเป็นต้องใช้
const express = require('express'); // ตัวสร้างเซิร์ฟเวอร์
const cors = require('cors'); // ตัวอนุญาตให้หน้าเว็บข้ามโดเมนมาคุยกับเซิร์ฟเวอร์ได้
const { createClient } = require('@supabase/supabase-js'); // ตัวเชื่อมต่อฐานข้อมูล Supabase
const http = require('http'); // ตัวจัดการระบบ HTTP พื้นฐาน
const { Server } = require('socket.io'); // ตัวทำระบบ Real-time (ให้ครัวเด้งอัตโนมัติ)

// เริ่มต้นสร้างเซิร์ฟเวอร์ Express
const app = express();
app.use(cors()); // เปิดประตูรับการเชื่อมต่อจากทุกเว็บ
app.use(express.json()); // ให้เซิร์ฟเวอร์อ่านข้อมูลแบบ JSON ได้

// ผูกระบบ Real-time (Socket.io) เข้ากับเซิร์ฟเวอร์
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// เชื่อมต่อฐานข้อมูล Supabase ด้วย URL และ Key ของคุณ
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==========================================
// 1. API: ดึงรายการเมนูอาหาร (ส่งไปให้หน้าลูกค้า)
// ==========================================
app.get('/api/menu', async (req, res) => {
    // ดึงข้อมูลทั้งหมดจากตาราง menu_items แล้วเรียงลำดับตาม ID
    const { data } = await supabase.from('menu_items').select('*').order('id');
    res.json(data); // ส่งข้อมูลกลับไปให้หน้าเว็บ
});

// ==========================================
// 2. API: รับออเดอร์จากลูกค้า (หัวใจหลักของระบบ)
// ==========================================
app.post('/api/orders', async (req, res) => {
    // รับข้อมูลที่ลูกค้าส่งมา (เบอร์โต๊ะ, รหัสเมนู, จำนวน, หมายเหตุ)
    const { table_id, menu_item_id, quantity, notes } = req.body;
    
    try {
        // ขั้นที่ 1: เช็คก่อนว่าโต๊ะนี้มีบิลเก่าที่ยังไม่จ่ายเงิน (unpaid) อยู่ไหม?
        let { data: existingOrder } = await supabase
            .from('orders')
            .select('id')
            .eq('table_id', table_id)
            .eq('status', 'unpaid')
            .maybeSingle(); // ค้นหาบิลใบเดียว

        let currentOrderId;

        // ขั้นที่ 2: จัดการบิล
        if (existingOrder) {
            // ถ้ามีบิลค้างอยู่แล้ว ให้ใช้ ID ของบิลเดิมเลย (ออเดอร์จะได้ไปรวมกัน)
            currentOrderId = existingOrder.id;
        } else {
            // ถ้ายังไม่มีบิล (เพิ่งมานั่ง) ให้สร้างบิลใบใหม่สถานะ unpaid
            const { data: newOrder, error: createError } = await supabase
                .from('orders')
                .insert([{ table_id: table_id, status: 'unpaid' }])
                .select()
                .single();
            if (createError) throw createError;
            currentOrderId = newOrder.id;
        }

        // ขั้นที่ 3: เอาเมนูอาหารใส่ลงไปในบิลนั้น
        const { error: itemError } = await supabase
            .from('order_items')
            .insert([{
                order_id: currentOrderId, // รหัสบิล
                menu_item_id: menu_item_id, // รหัสอาหาร
                quantity: quantity, // จำนวน
                status: 'pending', // 🌟 ประทับตราว่ากำลังรอทำ (ให้ครัวเห็น)
                notes: notes || "" // บันทึกหมายเหตุ ถ้าไม่มีให้เป็นค่าว่าง
            }]);

        if (itemError) throw itemError;

        // ขั้นที่ 4: ส่งสัญญาณสะกิดบอกหน้าครัวและหน้าแคชเชียร์ให้รีเฟรชจออัตโนมัติ!
        io.emit('update_kitchen');
        io.emit('update_cashier');
        
        // ตอบกลับหน้าเว็บลูกค้าว่า "ส่งออเดอร์สำเร็จนะ!"
        res.json({ success: true });
        
    } catch (error) {
        console.error("Order Error: ", error);
        res.status(500).json({ error: error.message }); // ถ้าพังให้แจ้ง Error
    }
});

// ==========================================
// 3. API: ดึงออเดอร์ไปโชว์ที่หน้าจอห้องครัว (KDS)
// ==========================================
app.get('/api/kitchen/orders', async (req, res) => {
    const { data, error } = await supabase
        .from('order_items')
        .select('id, quantity, status, notes, orders!inner(tables(table_number)), menu_items(name)')
        .eq('status', 'pending') // 🌟 ดึงเฉพาะอันที่สถานะ pending (รอทำ)
        .order('id', { ascending: true }); // 🌟 เรียงคิวตาม ID (มาก่อนได้ก่อน) ป้องกันปัญหาคอลัมน์เวลาชื่อไม่ตรงกัน
        
    if(error) console.error("Kitchen fetch error:", error);
    res.json(data || []);
});

// ==========================================
// 4. API: พ่อครัวกดปุ่ม "ทำเสร็จแล้ว" (อัปเดตสถานะ)
// ==========================================
app.put('/api/kitchen/orders/:id', async (req, res) => {
    // เปลี่ยนสถานะอาหารจานนั้นจาก pending เป็น served (เสิร์ฟแล้ว)
    await supabase.from('order_items').update({ status: 'served' }).eq('id', req.params.id);
    
    // สะกิดบอกหน้าครัวให้รีเฟรชจอ (จานที่เสร็จแล้วจะได้หายไป)
    io.emit('update_kitchen');
    res.json({ success: true });
});

// ==========================================
// 5. API: ดึงบิลไปแสดงหน้าแคชเชียร์ (POS)
// ==========================================
app.get('/api/cashier/orders', async (req, res) => {
    const { data, error } = await supabase
        .from('orders')
        .select('id, status, tables(table_number), order_items(quantity, menu_items(name, price))')
        .eq('status', 'unpaid') // ดึงเฉพาะบิลที่ยังไม่ได้จ่ายเงิน
        .order('id', { ascending: true }); // เรียงตาม ID
        
    res.json(data || []);
});

// ==========================================
// 6. API: แคชเชียร์กดปุ่ม "เช็คบิล"
// ==========================================
app.post('/api/cashier/checkout', async (req, res) => {
    // เปลี่ยนสถานะบิลจาก unpaid เป็น paid (จ่ายแล้ว)
    await supabase.from('orders').update({ status: 'paid' }).eq('id', req.body.order_id);
    
    // สะกิดบอกหน้าแคชเชียร์ให้รีเฟรชจอ (โต๊ะที่จ่ายแล้วจะได้หายไป)
    io.emit('update_cashier');
    res.json({ success: true });
});

// ==========================================
// จุดเริ่มต้น: สั่งให้เซิร์ฟเวอร์เปิดใช้งานและรอรับการเชื่อมต่อ
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));