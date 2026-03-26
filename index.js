require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==========================================
// 🛡️ ยามเฝ้าประตู (JWT Middleware)
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET || 'my-super-secret-pos-key-2024';

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 
    if (!token) return res.status(401).json({ success: false, error: 'Access Denied: ไม่พบบัตรยืนยันตัวตน' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, error: 'บัตรหมดอายุ หรือไม่ถูกต้อง กรุณาล็อกอินใหม่' });
        req.user = user;
        next(); // ผ่านได้!
    });
};

// 🔑 API ล็อกอินขอ Token
app.post('/api/admin/login', async (req, res) => {
    const { pin } = req.body;
    try {
        const { data, error } = await supabase.from('settings').select('admin_pin').eq('id', 1).single();
        if (error) throw error;

        const correctPin = data.admin_pin || "123456";
        if (pin === correctPin) {
            // สร้าง Token ให้อายุ 12 ชั่วโมง
            const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, error: 'รหัส PIN ไม่ถูกต้อง' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🍕 API ดึงรายการอาหารทั้งหมดไปโชว์ที่หน้ามือถือลูกค้า
app.get('/api/menu', async (req, res) => {
    try {
        // ดึงเมนูที่เปิดขาย (is_available = true) และของไม่หมด (is_out_of_stock = false)
        const { data, error } = await supabase
            .from('menu_items')
            .select('*')
            .eq('is_available', true)
            // .eq('is_out_of_stock', false) // ถ้าเถ้าแก่ใช้คอลัมน์นี้ เปิดคอมเมนต์บรรทัดนี้ได้เลยครับ
            .order('category', { ascending: true }) // เรียงหมวดหมู่ให้สวยงาม
            .order('id', { ascending: true });

        if (error) throw error;
        
        res.json({ success: true, data });
    } catch (error) {
        console.error("❌ Error fetching menu:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// ➕ เพิ่มเมนู (🛡️ ป้องกันแล้ว)
app.post('/api/admin/menu', verifyToken, async (req, res) => {
    const { name, price, category, image_url, target_categories } = req.body;
    const { error } = await supabase.from('menu_items')
        .insert([{ name, price, category, image_url, target_categories }]);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

// 🌟 API จัดเรียงเมนู (🛡️ ป้องกันแล้ว)
app.put('/api/admin/menu/reorder', verifyToken, async (req, res) => {
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

// 🚫 ปรับสถานะของหมด (🛡️ ป้องกันแล้ว)
app.put('/api/admin/menu/stock/:id', verifyToken, async (req, res) => {
    const { is_out_of_stock } = req.body;
    const { error } = await supabase.from('menu_items').update({ is_out_of_stock }).eq('id', req.params.id);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

// ✏️ API แก้ไขเมนู (🛡️ ป้องกันแล้ว)
app.put('/api/admin/menu/:id', verifyToken, async (req, res) => {
    const { name, price, category, image_url, target_categories } = req.body;
    const { error } = await supabase.from('menu_items')
        .update({ name, price, category, image_url, target_categories })
        .eq('id', req.params.id);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

// 🗑️ ลบเมนู (🛡️ ป้องกันแล้ว)
app.delete('/api/admin/menu/:id', verifyToken, async (req, res) => {
    const { error } = await supabase.from('menu_items').delete().eq('id', req.params.id);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

// 🛒 สั่งอาหาร (เพิ่มระบบตัดสต๊อกอัตโนมัติ!)
app.post('/api/orders', async (req, res) => {
    const { table_id, menu_item_id, quantity, notes, status } = req.body;
    try {
        let { data: checkTable } = await supabase.from('tables').select('id').eq('id', table_id).maybeSingle();
        if (!checkTable) {
            await supabase.from('tables').insert([{ id: table_id, table_number: String(table_id) }]);
        }

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

        // 🌟 [NEW] ระบบตัดสต๊อกวัตถุดิบ (Inventory Deduction) 🌟
        const { data: recipes } = await supabase.from('recipes').select('*').eq('menu_item_id', menu_item_id);
        
        if (recipes && recipes.length > 0) {
            for (let recipe of recipes) {
                // 💡 เปลี่ยนมาใช้ current_stock ตามตารางของคุณ
                const { data: invItem } = await supabase.from('inventory_items').select('current_stock').eq('id', recipe.inventory_item_id).single();
                
                if (invItem) {
                    const newStock = invItem.current_stock - (recipe.quantity_used * quantity);
                    await supabase.from('inventory_items').update({ current_stock: newStock }).eq('id', recipe.inventory_item_id);
                }
            }
        }
        
        io.emit('update_kitchen');
        io.emit('update_cashier');
        res.json({ success: true });
        
    } catch (error) {
        console.error("Order Error:", error);
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

// 💰 แคชเชียร์ (คำนวณยอดเงิน)
app.get('/api/cashier/orders', async (req, res) => {
    try {
        const { data, error } = await supabase.from('orders')
            .select('id, status, created_at, tables(table_number), order_items(id, quantity, status, ordered_at, notes, menu_items(name, price))')
            .eq('status', 'unpaid')
            .order('id', { ascending: true });
            
        if (error) throw error;
        
        const ordersWithCalculations = (data || []).map(order => {
            let total_amount = 0;
            let is_all_served = true;
            
            if (order.order_items) {
                order.order_items.forEach(item => {
                    total_amount += (item.menu_items?.price || 0) * item.quantity;
                    if (item.status !== 'served') is_all_served = false;
                });
            }
            
            return { ...order, calculated_total: total_amount, is_all_served: is_all_served };
        });

        res.json(ordersWithCalculations);
    } catch (error) {
        console.error("Error fetching orders:", error);
        res.status(500).json({ error: error.message });
    }
});

// 💰 ตัดบิล (แคชเชียร์)
app.post('/api/cashier/checkout', async (req, res) => {
    try {
        const { data: order } = await supabase.from('orders').select('table_id').eq('id', req.body.order_id).single();
        await supabase.from('orders').update({ status: 'paid' }).eq('id', req.body.order_id);
        io.emit('update_cashier');
        if (order) io.emit('clear_table', order.table_id); 
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

// 📊 ประวัติบิล & Dashboard (🛡️ ป้องกันแล้ว)
app.get('/api/admin/history', verifyToken, async (req, res) => {
    const { data } = await supabase.from('orders').select('id, created_at, status, tables(table_number), order_items(quantity, menu_items(name, price))').eq('status', 'paid').order('created_at', { ascending: false });
    res.json(data || []);
});

// 📊 Dashboard สรุปยอด (อัปเกรดให้เลือกระยะเวลาได้)
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        // 💡 รับค่า startDate และ endDate จากหน้าเว็บ
        const { startDate, endDate, date } = req.query; 
        
        let query = supabase.from('orders')
            .select('id, created_at, order_items(quantity, menu_items(name, price))')
            .eq('status', 'paid');
            
        // 📅 กรองช่วงเวลา (ถ้าส่งมาเป็นช่วง ให้ค้นหาตั้งแต่เริ่มวันแรก ถึงเที่ยงคืนของวันสุดท้าย)
        let start = startDate || date;
        let end = endDate || date;

        if (start && end) {
            const startOfDay = `${start}T00:00:00+07:00`;
            const endOfDay = `${end}T23:59:59+07:00`;
            query = query.gte('created_at', startOfDay).lte('created_at', endOfDay);
        }

        const { data, error } = await query;
        if (error) throw error;
        const orders = data || [];

        let totalRevenue = 0; let totalOrders = orders.length; let totalItemsSold = 0; let itemStats = {};

        orders.forEach(order => {
            order.order_items.forEach(item => {
                const itemName = item.menu_items?.name.split('(')[0].trim() || 'ไม่ทราบชื่อ';
                const qty = item.quantity;
                const price = item.menu_items?.price || 0;
                const itemRevenue = price * qty;

                totalRevenue += itemRevenue; totalItemsSold += qty;
                if (!itemStats[itemName]) itemStats[itemName] = { qty: 0, revenue: 0 };
                itemStats[itemName].qty += qty; itemStats[itemName].revenue += itemRevenue;
            });
        });

        const itemsArray = Object.keys(itemStats).map(name => ({ name: name, qty: itemStats[name].qty, revenue: itemStats[name].revenue }));
        const top5ByQty = [...itemsArray].sort((a, b) => b.qty - a.qty).slice(0, 5);
        const topByRevenue = [...itemsArray].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

        res.json({ success: true, summary: { total_revenue: totalRevenue, total_orders: totalOrders, total_items_sold: totalItemsSold }, top_items_by_qty: top5ByQty, top_items_by_revenue: topByRevenue });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 📱 ลูกค้า: เช็คสถานะโต๊ะ
app.get('/api/table/:id/status', async (req, res) => {
    try {
        const { data: order } = await supabase.from('orders')
            .select('id, status, order_items(quantity, status, menu_items(name, price))')
            .eq('table_id', req.params.id)
            .eq('status', 'unpaid')
            .maybeSingle(); 
        
        if (order) res.json({ isOpen: true, order: order });
        else res.json({ isOpen: false }); 
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ⚙️ ระบบตั้งค่าร้านค้า GET (ไม่ต้องป้องกัน ลูกค้าต้องดึงไปใช้)
app.get('/api/settings', async (req, res) => {
    try {
        const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ⚙️ อัปเดตการตั้งค่าร้านค้า (🛡️ ป้องกันแล้ว!)
app.put('/api/settings', verifyToken, async (req, res) => {
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
        const { error } = await supabase.from('order_items').update({ status: 'served' }).eq('id', item_id);
        if (error) throw error;
        
        io.emit('update_kitchen'); 
        io.emit('update_cashier'); 
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🔀 ระบบจัดการโต๊ะขั้นสูง (Move)
app.put('/api/orders/move', async (req, res) => {
    const { current_order_id, new_table_id, old_table_id } = req.body;
    try {
        const { data: existing } = await supabase.from('orders').select('id').eq('table_id', new_table_id).eq('status', 'unpaid').maybeSingle();
        if (existing) return res.status(400).json({ success: false, error: 'โต๊ะปลายทางไม่ว่าง (มีลูกค้าอยู่แล้ว)' });

        let { data: checkTable } = await supabase.from('tables').select('id').eq('id', new_table_id).maybeSingle();
        if (!checkTable) await supabase.from('tables').insert([{ id: new_table_id, table_number: String(new_table_id) }]);

        const { error } = await supabase.from('orders').update({ table_id: new_table_id }).eq('id', current_order_id);
        if (error) throw error;

        io.emit('update_cashier');
        io.emit('update_kitchen'); 
        io.emit('clear_table', old_table_id);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 🔗 ระบบจัดการโต๊ะขั้นสูง (Merge)
app.put('/api/orders/merge', async (req, res) => {
    const { source_order_id, target_table_id, old_table_id } = req.body;
    try {
        let { data: targetOrder } = await supabase.from('orders').select('id').eq('table_id', target_table_id).eq('status', 'unpaid').maybeSingle();
        if (!targetOrder) return res.status(400).json({ success: false, error: 'โต๊ะเป้าหมายไม่มีลูกค้าอยู่' });

        const { data: itemsToMove } = await supabase.from('order_items').select('id, notes').eq('order_id', source_order_id);
        if (itemsToMove) {
            for (let item of itemsToMove) {
                let newNote = item.notes ? item.notes + ` (รวมมาจากโต๊ะ ${old_table_id})` : `(รวมมาจากโต๊ะ ${old_table_id})`;
                await supabase.from('order_items').update({ order_id: targetOrder.id, notes: newNote }).eq('id', item.id);
            }
        }

        await supabase.from('orders').delete().eq('id', source_order_id);

        io.emit('update_cashier');
        io.emit('update_kitchen');
        io.emit('clear_table', old_table_id);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ==========================================
// 📦 ระบบคลังวัตถุดิบ (Inventory & Recipe)
// ==========================================

// --- ดึงข้อมูลวัตถุดิบ ---
app.get('/api/admin/inventory', verifyToken, async (req, res) => {
    const { data, error } = await supabase.from('inventory_items').select('*').order('name');
    res.json(data || []);
});

// --- เพิ่มวัตถุดิบใหม่ ---
app.post('/api/admin/inventory', verifyToken, async (req, res) => {
    // 💡 ดึง current_stock และ min_alert_level ตามตารางของคุณ
    const { name, current_stock, unit, min_alert_level } = req.body;
    const { error } = await supabase.from('inventory_items').insert([{ name, current_stock, unit, min_alert_level }]);
    res.json({ success: !error, error: error?.message });
});

// --- อัปเดตสต๊อก (เติมของ/แก้ไข) ---
app.put('/api/admin/inventory/:id', verifyToken, async (req, res) => {
    const { name, current_stock, unit, min_alert_level } = req.body;
    const { error } = await supabase.from('inventory_items').update({ name, current_stock, unit, min_alert_level }).eq('id', req.params.id);
    res.json({ success: !error, error: error?.message });
});

// --- ลบวัตถุดิบ ---
app.delete('/api/admin/inventory/:id', verifyToken, async (req, res) => {
    const { error } = await supabase.from('inventory_items').delete().eq('id', req.params.id);
    res.json({ success: !error, error: error?.message });
});

// --- ดึงสูตรอาหารทั้งหมด ---
app.get('/api/admin/recipes', verifyToken, async (req, res) => {
    const { data, error } = await supabase.from('recipes')
        .select('id, menu_item_id, quantity_used, inventory_items(id, name, unit), menu_items(name)');
    res.json(data || []);
});

// --- เพิ่มสูตรอาหาร (ผูกเมนูเข้ากับวัตถุดิบ) ---
app.post('/api/admin/recipes', verifyToken, async (req, res) => {
    const { menu_item_id, inventory_item_id, quantity_used } = req.body;
    const { error } = await supabase.from('recipes').insert([{ menu_item_id, inventory_item_id, quantity_used }]);
    res.json({ success: !error, error: error?.message });
});

// --- ลบส่วนผสมออกจากสูตร ---
app.delete('/api/admin/recipes/:id', verifyToken, async (req, res) => {
    const { error } = await supabase.from('recipes').delete().eq('id', req.params.id);
    res.json({ success: !error, error: error?.message });
});

// 📱 API สำหรับรับออเดอร์จากมือถือลูกค้า (QR Ordering) - ฉบับบันทึกลงฐานข้อมูลจริง!
app.post('/api/qr/orders', async (req, res) => {
    try {
        const { table_number, cart } = req.body;

        // 1. ค้นหาตาราง tables ก่อน ว่าเบอร์โต๊ะนี้ id อะไร
        const { data: tableData, error: tableError } = await supabase
            .from('tables')
            .select('id')
            .eq('table_number', table_number)
            .single();
            
        if (tableError || !tableData) {
            return res.status(400).json({ success: false, error: 'ไม่พบเบอร์โต๊ะนี้ในระบบ' });
        }

        const tableId = tableData.id;
        let orderId;

        // 2. เช็คว่าโต๊ะนี้มีบิลที่กำลัง "ทานอยู่" (dining) หรือไม่
        const { data: existingOrder } = await supabase
            .from('orders')
            .select('id')
            .eq('table_id', tableId)
            .eq('status', 'dining')
            .single();

        if (existingOrder) {
            // 📌 ถ้ามีบิลอยู่แล้ว ให้จด order_id เดิมไว้ (สั่งอาหารเพิ่ม)
            orderId = existingOrder.id;
        } else {
            // 📌 ถ้ายังไม่มีบิล (ลูกค้าเพิ่งมานั่ง) ให้เปิดบิลใหม่เลย
            const { data: newOrder, error: orderError } = await supabase
                .from('orders')
                .insert({ table_id: tableId, status: 'dining' })
                .select('id')
                .single();
                
            if (orderError) throw orderError;
            orderId = newOrder.id;
        }

        // 3. เอาอาหารในตะกร้า (cart) มาแปลงร่างเตรียมบันทึกลง order_items
        const orderItemsToInsert = cart.map(item => ({
            order_id: orderId,
            menu_item_id: item.id, 
            quantity: item.qty,
            notes: item.notes || '', // 👈 ไฮไลท์: เพิ่มบรรทัดนี้เพื่อให้หลังบ้านเซฟข้อความ Add-on ได้!
            status: 'pending' 
        }));
        // บันทึกลงฐานข้อมูล
        const { error: insertError } = await supabase
            .from('order_items')
            .insert(orderItemsToInsert);

        if (insertError) throw insertError;

        console.log(`🔔 บันทึกออเดอร์จากโต๊ะ ${table_number} สำเร็จ!`);

        // 4. 🪄 เวทมนตร์ Real-time: กระจายเสียงบอกทุกจอว่าออเดอร์เข้าแล้ว!
        io.emit('update_kitchen'); 
        io.emit('update_cashier'); 

        res.json({ success: true, message: 'ส่งออเดอร์เข้าครัวเรียบร้อย!' });
    } catch (error) {
        console.error("❌ Error QR Order:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));