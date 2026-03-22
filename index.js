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
    const { data } = await supabase.from('menu_items').select('*').order('id');
    res.json(data);
});

app.post('/api/orders', async (req, res) => {
    // 🌟 รับค่า status เพิ่มเข้ามา เพื่อทำระบบแอบส่งบิล
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
                status: status || 'pending', // 🌟 ถ้าหน้าเว็บส่ง served มา จะไม่เด้งเข้าครัว!
                notes: notes || ""
            }]);

        if (itemError) throw itemError;

        io.emit('update_kitchen');
        io.emit('update_cashier');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/kitchen/orders', async (req, res) => {
    const { data } = await supabase
        .from('order_items')
        .select('id, quantity, status, notes, orders!inner(tables(table_number)), menu_items(name)')
        .eq('status', 'pending').order('id', { ascending: true });
    res.json(data || []);
});

app.put('/api/kitchen/orders/:id', async (req, res) => {
    await supabase.from('order_items').update({ status: 'served' }).eq('id', req.params.id);
    io.emit('update_kitchen');
    res.json({ success: true });
});

app.get('/api/cashier/orders', async (req, res) => {
    const { data } = await supabase
        .from('orders')
        .select('id, status, tables(table_number), order_items(quantity, menu_items(name, price))')
        .eq('status', 'unpaid').order('id', { ascending: true });
    res.json(data || []);
});

app.post('/api/cashier/checkout', async (req, res) => {
    await supabase.from('orders').update({ status: 'paid' }).eq('id', req.body.order_id);
    io.emit('update_cashier');
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));