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
const io = new Server(server, { cors: { origin: "*" } });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ----------------------------------------
// API ดึงเมนูและออเดอร์
// ----------------------------------------
app.get('/', (req, res) => { res.send('ระบบ Backend ทำงานปกติ!'); });

app.get('/api/menu', async (req, res) => {
    const { data, error } = await supabase.from('menu_items').select('*');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/orders', async (req, res) => {
    const { table_id, menu_item_id, quantity } = req.body;
    try {
        const { data: newOrder, error: orderError } = await supabase
            .from('orders').insert([{ table_id, status: 'unpaid' }]).select().single();
        if (orderError) throw orderError;

        const { error: itemError } = await supabase
            .from('order_items').insert([{ order_id: newOrder.id, menu_item_id, quantity, status: 'pending' }]);
        if (itemError) throw itemError;

        // 🌟 มีออเดอร์ใหม่: ตะโกนบอกครัว และ บอกแคชเชียร์
        io.emit('update_kitchen');
        io.emit('update_cashier');

        res.json({ message: 'สั่งอาหารสำเร็จ!', orderId: newOrder.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ----------------------------------------
// API ระบบห้องครัว
// ----------------------------------------
app.get('/api/kitchen', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('order_items')
            .select('id, quantity, status, ordered_at, menu_items(name), orders(table_id)')
            .eq('status', 'pending').order('ordered_at', { ascending: true });
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/kitchen/:id', async (req, res) => {
    try {
        const { error } = await supabase
            .from('order_items').update({ status: 'completed', completed_at: new Date() }).eq('id', req.params.id);
        if (error) throw error;

        // 🌟 ครัวทำเสร็จ: ตะโกนบอกหน้าจอครัว
        io.emit('update_kitchen');

        res.json({ message: 'อัปเดตสถานะเรียบร้อย!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ----------------------------------------
// API ระบบแคชเชียร์
// ----------------------------------------
app.get('/api/cashier/orders', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('id, status, tables(table_number), order_items(quantity, menu_items(name, price))')
            .eq('status', 'unpaid');
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/cashier/checkout', async (req, res) => {
    const { order_id, phone_number, total_amount } = req.body;
    try {
        await supabase.from('orders').update({ status: 'paid', total_amount, customer_phone: phone_number || null }).eq('id', order_id);
        
        if (phone_number) {
            const pointsEarned = Math.floor(total_amount / 100);
            const { data } = await supabase.from('customers').select('*').eq('phone_number', phone_number).single();
            if (data) {
                await supabase.from('customers').update({ points: data.points + pointsEarned }).eq('phone_number', phone_number);
            } else {
                await supabase.from('customers').insert([{ phone_number, points: pointsEarned }]);
            }
        }
        
        // 🌟 เช็คบิลเสร็จ: ตะโกนบอกแคชเชียร์ให้ซ่อนบิลนี้ไปเลย!
        io.emit('update_cashier'); 
        
        res.json({ message: 'เช็คบิลเรียบร้อย!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ เซิร์ฟเวอร์พร้อมทำงานที่ http://localhost:${PORT}`);
});