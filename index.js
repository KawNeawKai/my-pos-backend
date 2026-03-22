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

app.get('/api/menu', async (req, res) => {
    const { data, error } = await supabase.from('menu_items').select('*').order('id');
    res.json(data);
});

app.post('/api/orders', async (req, res) => {
    const { table_id, menu_item_id, quantity } = req.body;
    try {
        let { data: existingOrder } = await supabase
            .from('orders')
            .select('id')
            .eq('table_id', table_id)
            .eq('status', 'unpaid')
            .maybeSingle(); 

        let currentOrderId;

        if (existingOrder) {
            currentOrderId = existingOrder.id;
        } else {
            const { data: newOrder, error: createError } = await supabase
                .from('orders')
                .insert([{ table_id: table_id, status: 'unpaid' }])
                .select()
                .single();
            if (createError) throw createError;
            currentOrderId = newOrder.id;
        }

        // 🌟 แก้ไขตรงนี้: เพิ่ม status: 'pending' ให้หน้าครัวมองเห็น!
        const { error: itemError } = await supabase
            .from('order_items')
            .insert([{ order_id: currentOrderId, menu_item_id: menu_item_id, quantity: quantity, status: 'pending' }]);
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
        .select('id, quantity, status, orders!inner(tables(table_number)), menu_items(name)')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
    res.json(data || []);
});

app.put('/api/kitchen/orders/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    await supabase.from('order_items').update({ status }).eq('id', id);
    io.emit('update_kitchen');
    io.emit('update_cashier');
    res.json({ success: true });
});

app.get('/api/cashier/orders', async (req, res) => {
    const { data, error } = await supabase
        .from('orders')
        .select('id, status, tables(table_number), order_items(quantity, menu_items(name, price))')
        .eq('status', 'unpaid')
        .order('created_at', { ascending: true });
    res.json(data || []);
});

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