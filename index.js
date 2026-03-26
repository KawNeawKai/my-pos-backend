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

// ==========================================
// 🔑 ระบบ Login
// ==========================================
app.post('/api/admin/login', async (req, res) => {
    const { pin } = req.body;
    try {
        const { data, error } = await supabase.from('settings').select('admin_pin').eq('id', 1).single();
        if (error) throw error;

        const correctPin = data.admin_pin || "123456";
        if (pin === correctPin) {
            const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, error: 'รหัส PIN ไม่ถูกต้อง' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 🍕 ระบบเมนูอาหาร
// ==========================================
app.get('/api/menu', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('menu_items')
            .select('*')
            .eq('is_available', true)
            .order('id', { ascending: true });
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/menu', verifyToken, async (req, res) => {
    const { name, price, category, image_url, target_categories } = req.body;
    const { error } = await supabase.from('menu_items').insert([{ name, price, category, image_url, target_categories }]);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

app.put('/api/admin/menu/reorder', verifyToken, async (req, res) => {
    const { items } = req.body;
    try {
        let successCount = 0; 
        for (let item of items) {
            const { data, error } = await supabase.from('menu_items')
                .update({ category_order: item.category_order, item_order: item.item_order, category: item.category })
                .eq('id', item.id).select(); 
            if (error) throw error;
            if (data && data.length > 0) successCount++;
        }
        io.emit('update_menu');
        res.json({ success: true, updated: successCount, total: items.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/admin/menu/stock/:id', verifyToken, async (req, res) => {
    const { is_out_of_stock } = req.body;
    const { error } = await supabase.from('menu_items').update({ is_out_of_stock }).eq('id', req.params.id);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

app.put('/api/admin/menu/:id', verifyToken, async (req, res) => {
    const { name, price, category, image_url, target_categories } = req.body;
    const { error } = await supabase.from('menu_items')
        .update({ name, price, category, image_url, target_categories })
        .eq('id', req.params.id);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

app.delete('/api/admin/menu/:id', verifyToken, async (req, res) => {
    const { error } = await supabase.from('menu_items').delete().eq('id', req.params.id);
    io.emit('update_menu');
    res.json({ success: !error, error: error?.message });
});

// ==========================================
// 🛒 ระบบสั่งอาหาร (หน้าเคาน์เตอร์ & QR Code)
// ==========================================
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

        // ระบบตัดสต๊อกวัตถุดิบ
        const { data: recipes } = await supabase.from('recipes').select('*').eq('menu_item_id', menu_item_id);
        if (recipes && recipes.length > 0) {
            for (let recipe of recipes) {
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
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/qr/orders', async (req, res) => {
    try {
        const { table_number, cart } = req.body;
        const { data: tableData, error: tableError } = await supabase
            .from('tables')
            .select('id')
            .or(`table_number.eq.${table_number}, table_number.eq.โต๊ะ ${table_number}`)
            .single();
            
        if (tableError || !tableData) return res.status(400).json({ success: false, error: `ไม่พบเบอร์โต๊ะ ${table_number} ในฐานข้อมูล` });

        const tableId = tableData.id;
        let orderId;

        const { data: existingOrder } = await supabase.from('orders').select('id').eq('table_id', tableId).eq('status', 'dining').single();

        if (existingOrder) {
            orderId = existingOrder.id;
        } else {
            const { data: newOrder, error: orderError } = await supabase.from('orders').insert({ table_id: tableId, status: 'dining' }).select('id').single();
            if (orderError) throw orderError;
            orderId = newOrder.id;
        }

        const orderItemsToInsert = cart.map(item => ({
            order_id: orderId,
            menu_item_id: item.id, 
            quantity: item.qty,
            notes: item.notes || '',
            status: 'pending' 
        }));

        const { error: insertError } = await supabase.from('order_items').insert(orderItemsToInsert);
        if (insertError) throw insertError;

        io.emit('update_kitchen'); 
        io.emit('update_cashier'); 
        res.json({ success: true, message: 'ส่งออเดอร์เข้าครัวเรียบร้อย!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 👨‍🍳 ระบบห้องครัว
// ==========================================
app.get('/api/kitchen/orders', async (req, res) => {
    const { data } = await supabase.from('order_items').select('id, quantity, status, notes, ordered_at, orders!inner(tables(table_number)), menu_items(name)').eq('status', 'pending').order('id', { ascending: true });
    res.json(data || []);
});

app.put('/api/kitchen/orders/:id', async (req, res) => {
    await supabase.from('order_items').update({ status: 'served' }).eq('id', req.params.id);
    io.emit('update_kitchen');
    res.json({ success: true });
});

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

// ==========================================
// 💰 ระบบแคชเชียร์ & จัดการโต๊ะ
// ==========================================

// ดึงข้อมูลโต๊ะที่กำลังกิน (พร้อมคำนวณยอดเงิน) ✅ ตัวที่ถูกต้อง
app.get('/api/cashier/orders', async (req, res) => {
    try {
        const { data: orders, error } = await supabase
            .from('orders')
            .select(`
                id,
                status,
                tables ( table_number ),
                order_items ( quantity, status, menu_items ( price ) )
            `)
            .eq('status', 'dining');

        if (error) throw error;

        const formattedOrders = orders.map(order => {
            let totalAmount = 0;
            let allServed = true;

            if (order.order_items && order.order_items.length > 0) {
                order.order_items.forEach(item => {
                    const price = item.menu_items?.price || 0;
                    totalAmount += price * item.quantity;
                    if (item.status === 'pending') allServed = false; 
                });
            }

            return {
                id: order.id,
                table_number: order.tables?.table_number,
                calculated_total: totalAmount,
                is_all_served: allServed
            };
        });
        res.json(formattedOrders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// เช็คบิล (รวมเงินทอน) ✅ ตัวที่ถูกต้อง (รวมจาก 3 ตัวให้เหลือ 1)
app.post('/api/cashier/checkout', async (req, res) => {
    try {
        const { order_id, received_amount, change_amount } = req.body;
        const { error } = await supabase.from('orders')
            .update({ 
                status: 'completed',
                received_amount: received_amount,
                change_amount: change_amount
            })
            .eq('id', order_id);

        if (error) throw error;

        io.emit('clear_table');
        io.emit('update_cashier');
        io.emit('update_dashboard');
        res.json({ success: true, message: 'เช็คบิลสำเร็จ!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

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
// ⚙️ ระบบตั้งค่าร้านค้า (Settings)
// ==========================================

// ดึงการตั้งค่าร้าน ✅ (ตัวที่ถูกต้อง ดึงจากฐานข้อมูลตรงๆ)
app.get('/api/settings', async (req, res) => {
    try {
        const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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

// ==========================================
// 📊 ระบบสถิติ (Dashboard & History)
// ==========================================
app.get('/api/admin/history', verifyToken, async (req, res) => {
    const { data } = await supabase.from('orders').select('id, created_at, status, tables(table_number), order_items(quantity, menu_items(name, price))').eq('status', 'paid').order('created_at', { ascending: false });
    res.json(data || []);
});

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const { startDate, endDate, date } = req.query; 
        let query = supabase.from('orders').select('id, created_at, order_items(quantity, menu_items(name, price))').eq('status', 'paid');
            
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

// ==========================================
// 📦 ระบบคลังวัตถุดิบ (Inventory & Recipe)
// ==========================================
app.get('/api/admin/inventory', verifyToken, async (req, res) => {
    const { data, error } = await supabase.from('inventory_items').select('*').order('name');
    res.json(data || []);
});

app.post('/api/admin/inventory', verifyToken, async (req, res) => {
    const { name, current_stock, unit, min_alert_level } = req.body;
    const { error } = await supabase.from('inventory_items').insert([{ name, current_stock, unit, min_alert_level }]);
    res.json({ success: !error, error: error?.message });
});

app.put('/api/admin/inventory/:id', verifyToken, async (req, res) => {
    const { name, current_stock, unit, min_alert_level } = req.body;
    const { error } = await supabase.from('inventory_items').update({ name, current_stock, unit, min_alert_level }).eq('id', req.params.id);
    res.json({ success: !error, error: error?.message });
});

app.delete('/api/admin/inventory/:id', verifyToken, async (req, res) => {
    const { error } = await supabase.from('inventory_items').delete().eq('id', req.params.id);
    res.json({ success: !error, error: error?.message });
});

app.get('/api/admin/recipes', verifyToken, async (req, res) => {
    const { data, error } = await supabase.from('recipes')
        .select('id, menu_item_id, quantity_used, inventory_items(id, name, unit), menu_items(name)');
    res.json(data || []);
});

app.post('/api/admin/recipes', verifyToken, async (req, res) => {
    const { menu_item_id, inventory_item_id, quantity_used } = req.body;
    const { error } = await supabase.from('recipes').insert([{ menu_item_id, inventory_item_id, quantity_used }]);
    res.json({ success: !error, error: error?.message });
});

app.delete('/api/admin/recipes/:id', verifyToken, async (req, res) => {
    const { error } = await supabase.from('recipes').delete().eq('id', req.params.id);
    res.json({ success: !error, error: error?.message });
});

// 🚀 สตาร์ทเซิร์ฟเวอร์
const PORT = process.env.PORT || 5000; // เปลี่ยนเป็น 5000 จะได้ไม่ชนกับ Next.js หน้าบ้าน
server.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));