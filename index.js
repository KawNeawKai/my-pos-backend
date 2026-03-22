require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. ดึงข้อมูลเมนูอาหาร
app.get('/api/menu', async (req, res) => {
    const { data, error } = await supabase.from('menu_items').select('*').order('id');
    res.json(data);
});

// 🌟 2. ส่งออเดอร์ (อัปเกรด: รวมบิลโต๊ะเดียวกันให้อัตโนมัติ!)
app.post('/api/orders', async (req, res) => {
    const { table_id, menu_item_id, quantity } = req.body;
    try {
        // ขั้นที่ 1: เช็คก่อนว่าโต๊ะนี้มีบิลที่ยังไม่ได้จ่ายเงินอยู่หรือเปล่า
        let { data: existingOrder } = await supabase
            .from('orders')
            .select('id')
            .eq('table_id', table_id)
            .eq('status', 'unpaid')
            .maybeSingle(); // หาบิลเดียว ถ้าไม่มีจะคืนค่า null

        let currentOrderId;

        if (existingOrder) {
            // ถ้ามีบิลค้างอยู่ ให้ใช้เลข ID ของบิลเดิมเลย
            currentOrderId = existingOrder.id;
        } else {
            // ถ้ายังไม่มีบิล (ลูกค้าเพิ่งสั่งครั้งแรก) ให้เปิดบิลใบใหม่
            const { data: newOrder, error: createError } = await supabase
                .from('orders')
                .insert([{ table_id: table_id, status: 'unpaid' }])
                .select()
                .single();
            if (createError) throw createError;
            currentOrderId = newOrder.id;
        }

        // ขั้นที่ 2: เอาเมนูอาหารที่ลูกค้าสั่ง ยัดลงไปในบิล (ไม่ว่าจะบิลเก่าหรือบิลใหม่)
        const { error: itemError } = await supabase
            .from('order_items')
            .insert([{ order_id: currentOrderId, menu_item_id: menu_item_id, quantity: quantity }]);
        if (itemError) throw itemError;

        // ขั้นที่ 3: ส่งสัญญาณเตือนให้หน้าครัวและหน้าแคชเชียร์อัปเดตข้อมูล
        io.emit('update_kitchen');
        io.emit('update_cashier');
        
        res.json({ success: true });
    } catch (error) {
        console.error("Order Error: ", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. ดึงออเดอร์ไปแสดงที่หน้าห้องครัว
app.get('/api/kitchen/orders', async (req, res) => {
    const { data, error } = await supabase
        .from('order_items')
        .select('id, quantity, status, orders!inner(tables(table_number)), menu_items(name)')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
    res.json(data || []);
});

// 4. ห้องครัวกดปุ่ม "เสิร์ฟแล้ว" (อัปเดตสถานะ)
app.put('/api/kitchen/orders/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    await supabase.from('order_items').update({ status }).eq('id', id);
    io.emit('update_kitchen');
    io.emit('update_cashier');
    res.json({ success: true });
});

// 5. ดึงออเดอร์ไปแสดงหน้าแคชเชียร์
app.get('/api/cashier/orders', async (req, res) => {
    const { data, error } = await supabase
        .from('orders')
        .select('id, status, tables(table_number), order_items(quantity, menu_items(name, price))')
        .eq('status', 'unpaid')
        .order('created_at', { ascending: true });
    res.json(data || []);
});

// 6. แคชเชียร์กดปุ่ม "เช็คบิล"
app.post('/api/cashier/checkout', async (req, res) => {
    const { order_id } = req.body;
    await supabase.from('orders').update({ status: 'paid' }).eq('id', order_id);
    io.emit('update_cashier');
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});