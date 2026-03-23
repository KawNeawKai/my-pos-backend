require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 🍔 ดึงเมนูทั้งหมด
app.get('/api/menu', async (req, res) => {
    const { data } = await supabase.from('menu_items')
        .select('*')
        .order('category_order', { ascending: true })
        .order('item_order', { ascending: true })
        .order('id', { ascending: true });
    res.json(data || []);
});

// ➕ เพิ่มเมนู
app.post('/api/admin/menu', async (req, res) => {
    const { name, price, category, image_url, target_categories } = req.body;
    const { error } = await supabase.from('menu_items')
        .insert([{ name, price, category, image_url, target_categories }]);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

// 🌟 ย้ายมาไว้ตรงนี้! API จัดเรียงเมนู (ต้องอยู่เหนือคำว่า /:id เด็ดขาด)
app.put('/api/admin/menu/reorder', async (req, res) => {
    const { items } = req.body;
    try {
        let successCount = 0; 
        for (let item of items) {
            const { data, error } = await supabase.from('menu_items')
                .update({ 
                    category_order: item.category_order, 
                    item_order: item.item_order,
                    category: item.category 
                })
                .eq('id', item.id)
                .select(); 
                
            if (error) throw error;
            if (data && data.length > 0) successCount++;
        }
        io.emit('update_menu');
        res.json({ success: true, updated: successCount, total: items.length });
    } catch (error) {
        console.error("Reorder Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🚫 ปรับสถานะของหมด
app.put('/api/admin/menu/stock/:id', async (req, res) => {
    const { is_out_of_stock } = req.body;
    const { error } = await supabase.from('menu_items').update({ is_out_of_stock }).eq('id', req.params.id);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

// ✏️ API แก้ไขเมนู (ถูกดันลงมาอยู่ข้างล่างแล้ว จะได้ไม่แย่งซีนกัน)
app.put('/api/admin/menu/:id', async (req, res) => {
    const { name, price, category, image_url, target_categories } = req.body;
    const { error } = await supabase.from('menu_items')
        .update({ name, price, category, image_url, target_categories })
        .eq('id', req.params.id);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

// 🗑️ ลบเมนู
app.delete('/api/admin/menu/:id', async (req, res) => {
    const { error } = await supabase.from('menu_items').delete().eq('id', req.params.id);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

// 🛒 สั่งอาหาร
app.post('/api/orders', async (req, res) => {
    const { table_id, menu_item_id, quantity, notes, status } = req.body;
    try {
        let { data: existingOrder } = await supabase.from('orders').select('id').eq('table_id', table_id).eq('status', 'unpaid').maybeSingle();
        let currentOrderId = existingOrder ? existingOrder.id : null;
        if (!currentOrderId) {
            const { data: newOrder, error: createError } = await supabase.from('orders').insert([{ table_id, status: 'unpaid' }]).select().single();
            if (createError) throw createError;
            currentOrderId = newOrder.id;
        }
        const { error: itemError } = await supabase.from('order_items').insert([{
            order_id: currentOrderId, menu_item_id, quantity, status: status || 'pending', notes: notes || ""
        }]);
        if (itemError) throw itemError;
        io.emit('update_kitchen');
        io.emit('update_cashier');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 👨‍🍳 ครัว
app.get('/api/kitchen/orders', async (req, res) => {
    const { data } = await supabase.from('order_items').select('id, quantity, status, notes, ordered_at, orders!inner(tables(table_number)), menu_items(name)').eq('status', 'pending').order('id', { ascending: true });
    res.json(data || []);
});
app.put('/api/kitchen/orders/:id', async (req, res) => {
    await supabase.from('order_items').update({ status: 'served' }).eq('id', req.params.id);
    io.emit('update_kitchen');
    res.json({ success: true });
});

// 💰 แคชเชียร์ & ครัว (ดึงข้อมูลออเดอร์)
app.get('/api/cashier/orders', async (req, res) => {
    // 🌟 แก้ไข: ดึง id (เพื่อกดเสิร์ฟ), created_at (เพื่อจับเวลา), และ notes (หมายเหตุ)
    const { data } = await supabase.from('orders')
        .select('id, status, created_at, tables(table_number), order_items(id, quantity, status, created_at, notes, menu_items(name, price))')
        .eq('status', 'unpaid')
        .order('id', { ascending: true });
    res.json(data || []);
});

// 💰 ตัดบิล (แคชเชียร์)
app.post('/api/cashier/checkout', async (req, res) => {
    try {
        // 1. แอบดูข้อมูลบิลก่อนว่าคือ "โต๊ะเบอร์อะไร"
        const { data: order } = await supabase.from('orders').select('table_id').eq('id', req.body.order_id).single();
        
        // 2. อัปเดตสถานะเป็น "จ่ายเงินแล้ว (paid)"
        await supabase.from('orders').update({ status: 'paid' }).eq('id', req.body.order_id);
        
        // 3. สั่งแคชเชียร์ให้รีเฟรชหน้าต่าง
        io.emit('update_cashier');
        
        // 🌟 4. ตะโกนบอกหน้าลูกค้าว่า "โต๊ะนี้จ่ายเงินแล้ว รีเฟรชเดี๋ยวนี้!"
        if (order) {
            io.emit('clear_table', order.table_id); 
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ⭐ แต้มสะสม
app.post('/api/cashier/points', async (req, res) => {
    const { phone_number, points_earned } = req.body;
    try {
        let { data: customer } = await supabase.from('customers').select('*').eq('phone_number', phone_number).maybeSingle();
        let newTotal = points_earned;
        if (customer) {
            newTotal = (customer.points || 0) + points_earned;
            await supabase.from('customers').update({ points: newTotal }).eq('phone_number', phone_number);
        } else {
            await supabase.from('customers').insert([{ phone_number, points: newTotal }]);
        }
        res.json({ success: true, total_points: newTotal });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 📊 ประวัติบิล & Dashboard
app.get('/api/admin/history', async (req, res) => {
    const { data } = await supabase.from('orders').select('id, created_at, status, tables(table_number), order_items(quantity, menu_items(name, price))').eq('status', 'paid').order('created_at', { ascending: false });
    res.json(data || []);
});
app.get('/api/dashboard/stats', async (req, res) => {
    const { data } = await supabase.from('orders').select('id, created_at, order_items(quantity, menu_items(name, price))').eq('status', 'paid');
    res.json(data || []);
});

// 📱 ลูกค้า: เช็คสถานะโต๊ะ (เปิดโต๊ะอยู่ไหม? และสั่งอะไรไปแล้วบ้าง?)
app.get('/api/table/:id/status', async (req, res) => {
    try {
        const { data: order } = await supabase.from('orders')
            .select('id, status, order_items(quantity, status, menu_items(name, price))')
            .eq('table_id', req.params.id)
            .eq('status', 'unpaid')
            .maybeSingle(); // หาบิลที่ยังไม่จ่ายของโต๊ะนี้
        
        if (order) {
            res.json({ isOpen: true, order: order });
        } else {
            res.json({ isOpen: false }); // โต๊ะว่าง (เพิ่งจ่ายเงินไป หรือยังไม่มีคนนั่ง)
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ⚙️ ระบบตั้งค่าร้านค้า (Store Settings)
app.get('/api/settings', async (req, res) => {
    try {
        const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/settings', async (req, res) => {
    // 🌟 เพิ่ม sla_warning_time, sla_alert_time, alert_sound
    const { 
        store_name, promptpay_number, total_tables, receipt_footer, 
        is_store_open, points_rate, store_logo_url, closed_message,
        store_address, store_phone, admin_pin,
        sla_warning_time, sla_alert_time, alert_sound
    } = req.body;

    try {
        const { error } = await supabase.from('settings').update({ 
            store_name, promptpay_number, total_tables, receipt_footer,
            is_store_open, points_rate, store_logo_url, closed_message,
            store_address, store_phone, admin_pin,
            sla_warning_time, sla_alert_time, alert_sound
        }).eq('id', 1);

        if (error) throw error;
        
        io.emit('update_settings'); 
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🍳 API สำหรับหน้าจอครัว: อัปเดตสถานะอาหารว่า "ทำเสร็จ/เสิร์ฟแล้ว"
app.put('/api/orders/serve', async (req, res) => {
    const { item_id } = req.body;
    try {
        // อัปเดตสถานะในฐานข้อมูลเป็น served
        const { error } = await supabase
            .from('order_items')
            .update({ status: 'served' })
            .eq('id', item_id);
            
        if (error) throw error;
        
        // 🌟 เพิ่ม Socket.io ตะโกนบอกหน้าจออื่นๆ ทันทีที่ทำเสร็จ!
        io.emit('update_kitchen'); // ให้หน้าจอครัวเครื่องอื่นๆ รีเฟรช (เผื่อมีครัวหลายจอ)
        io.emit('update_cashier'); // ให้แคชเชียร์เห็นว่าอาหารเสิร์ฟแล้ว (เปลี่ยนเป็นสีเขียว)
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));