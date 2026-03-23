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

app.get('/api/menu', async (req, res) => {
    // 🌟 ดึงข้อมูลและเรียงลำดับตามที่เราจัดไว้
    const { data } = await supabase.from('menu_items')
        .select('*')
        .order('category_order', { ascending: true })
        .order('item_order', { ascending: true })
        .order('id', { ascending: true }); // สำรองไว้เผื่อเพิ่มใหม่
    res.json(data);
});

app.post('/api/orders', async (req, res) => {
    const { table_id, menu_item_id, quantity, notes, status } = req.body;
    try {
        let { data: existingOrder } = await supabase
            .from('orders').select('id').eq('table_id', table_id).eq('status', 'unpaid').maybeSingle();

        let currentOrderId;
        if (existingOrder) {
            currentOrderId = existingOrder.id;
        } else {
            const { data: newOrder, error: createError } = await supabase
                .from('orders').insert([{ table_id: table_id, status: 'unpaid' }]).select().single();
            if (createError) throw createError;
            currentOrderId = newOrder.id;
        }

        const { error: itemError } = await supabase
            .from('order_items')
            .insert([{
                order_id: currentOrderId,
                menu_item_id: menu_item_id,
                quantity: quantity,
                status: status || 'pending',
                notes: notes || ""
            }]);

        if (itemError) throw itemError;

        io.emit('update_kitchen');
        io.emit('update_cashier');
        res.json({ success: true });
    } catch (error) {
        console.error("Order Error: ", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/kitchen/orders', async (req, res) => {
    const { data, error } = await supabase
        .from('order_items')
        // 🌟 เปลี่ยนตรงนี้ครับ! ให้ตรงกับฐานข้อมูลเป๊ะๆ (ordered_at)
        .select('id, quantity, status, notes, ordered_at, orders!inner(tables(table_number)), menu_items(name)')
        .eq('status', 'pending')
        .order('id', { ascending: true });
        
    if(error) console.error("Kitchen fetch error:", error);
    res.json(data || []);
});

app.put('/api/kitchen/orders/:id', async (req, res) => {
    await supabase.from('order_items').update({ status: 'served' }).eq('id', req.params.id);
    io.emit('update_kitchen');
    res.json({ success: true });
});

app.get('/api/cashier/orders', async (req, res) => {
    const { data, error } = await supabase
        .from('orders')
        .select('id, status, tables(table_number), order_items(quantity, menu_items(name, price))')
        .eq('status', 'unpaid')
        .order('id', { ascending: true });
    res.json(data || []);
});

app.post('/api/cashier/checkout', async (req, res) => {
    await supabase.from('orders').update({ status: 'paid' }).eq('id', req.body.order_id);
    io.emit('update_cashier');
    res.json({ success: true });
});

// ==========================================
// 🌟 API: ระบบสะสมแต้มสมาชิก (ลูกค้าใหม่เริ่ม 0)
// ==========================================
app.post('/api/cashier/points', async (req, res) => {
    const { phone_number, points_earned } = req.body;
    
    try {
        // 1. ลองค้นหาเบอร์นี้ในตาราง customers ก่อน
        let { data: customer } = await supabase
            .from('customers')
            .select('*')
            .eq('phone_number', phone_number)
            .maybeSingle();

        let newTotal = points_earned;

        if (customer) {
            // 2. ถ้ามีประวัติอยู่แล้ว เอาแต้มเก่า (ถ้ามี) มาบวกแต้มใหม่
            newTotal = (customer.points || 5) + points_earned;
            
            await supabase
                .from('customers')
                .update({ points: newTotal })
                .eq('phone_number', phone_number);
        } else {
            // 3. ถ้าเป็นลูกค้าใหม่ (หาไม่เจอ) ให้สร้างข้อมูลใหม่เลย
            await supabase
                .from('customers')
                .insert([{ phone_number: phone_number, points: newTotal }]);
        }

        // ส่งแต้มสะสมสุทธิกลับไปให้หน้าแคชเชียร์ทำใบเสร็จ
        res.json({ success: true, total_points: newTotal });
        
    } catch (error) {
        console.error("Points Error: ", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 📊 API: สำหรับหน้า Dashboard (ดึงข้อมูลบิลที่จ่ายเงินแล้ว)
// ==========================================
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('id, created_at, order_items(quantity, menu_items(name, price))')
            .eq('status', 'paid'); // ดึงเฉพาะบิลที่จ่ายแล้วเท่านั้น
            
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Dashboard Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 🛠️ API: ระบบจัดการหลังบ้าน (Admin Panel)
// ==========================================

// 1. เพิ่มเมนูใหม่
app.post('/api/admin/menu', async (req, res) => {
    // 🌟 รับค่า target_categories เพิ่มเข้ามา
    const { name, price, category, image_url, target_categories } = req.body;
    const { error } = await supabase
        .from('menu_items')
        .insert([{ name, price, category, image_url, target_categories }]);
    res.json({ success: !error, error: error?.message });
});

// 2. ลบเมนูทิ้ง
app.delete('/api/admin/menu/:id', async (req, res) => {
    const { error } = await supabase
        .from('menu_items')
        .delete()
        .eq('id', req.params.id);
    res.json({ success: !error, error: error?.message });
});

// 3. ปรับสถานะ "ของหมด" (Out of stock)
app.put('/api/admin/menu/stock/:id', async (req, res) => {
    const { is_out_of_stock } = req.body;
    const { error } = await supabase
        .from('menu_items')
        .update({ is_out_of_stock })
        .eq('id', req.params.id);
    // แจ้งเตือนหน้าลูกค้าให้รีเฟรชเมนูอัตโนมัติ (ถ้าต้องการ)
    io.emit('update_menu'); 
    res.json({ success: !error, error: error?.message });
});

// 4. ดูประวัติบิลทั้งหมดแบบย้อนหลัง
app.get('/api/admin/history', async (req, res) => {
    const { data, error } = await supabase
        .from('orders')
        .select('id, created_at, status, tables(table_number), order_items(quantity, menu_items(name, price))')
        .eq('status', 'paid') // ดึงเฉพาะบิลที่จ่ายเงินแล้ว
        .order('created_at', { ascending: false }); // เรียงจากใหม่ไปเก่า
    res.json(data || []);
    
});

// 5. แก้ไขข้อมูลเมนู (อัปเดต ชื่อ, ราคา, หมวดหมู่, รูปภาพ)
app.put('/api/admin/menu/:id', async (req, res) => {
    // 🌟 รับค่า target_categories เพิ่มเข้ามา
    const { name, price, category, image_url, target_categories } = req.body;
    const { error } = await supabase
        .from('menu_items')
        .update({ name, price, category, image_url, target_categories })
        .eq('id', req.params.id);
        
    io.emit('update_menu'); 
    res.json({ success: !error, error: error?.message });
});

// 6. บันทึกการเรียงลำดับเมนูและหมวดหมู่ (Drag & Drop)
app.put('/api/admin/menu/reorder', async (req, res) => {
    const { items } = req.body;
    try {
        // อัปเดตข้อมูลตำแหน่งของเมนูทีละตัว
        const updates = items.map(item => 
            supabase.from('menu_items')
            .update({ category_order: item.category_order, item_order: item.item_order })
            .eq('id', item.id)
        );
        await Promise.all(updates);
        io.emit('update_menu'); // สั่งหน้าลูกค้าให้รีเฟรชอัปเดตตาม
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));