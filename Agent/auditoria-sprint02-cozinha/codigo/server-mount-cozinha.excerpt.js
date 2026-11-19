// Trecho efetivo backend/server.js (Sprint 02) — cópia para auditoria
const cozinhaRoutes = require('./rotas/cozinha');
// ...
app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);
