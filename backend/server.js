const path = require('path');

console.log('SERVER RODANDO DE:', process.cwd());
console.log('SERVER FILE:', __filename);

// Cofre MBC + DB_DIR alinhados ao Gateway OAuth. Sem logar o valor da chave.
try {
  const {
    bootstrapAmbienteOperacionalMbc
  } = require('./motores/bancario/secrets/bootstrapAmbienteOperacionalMbc');
  const mbcBoot = bootstrapAmbienteOperacionalMbc({ exigirRedirectUri: false });
  if (mbcBoot.secret_store_disponivel) {
    console.log('[MBC] SecretStore local disponível (origem=' + mbcBoot.secret_store_origem + ').');
  } else {
    console.warn('[MBC] SecretStore local indisponível — gravar credenciais bancárias falhará até configurar MBC_SECRET_STORE_KEY.');
  }
} catch (e) {
  console.warn('[MBC] Não foi possível inicializar SecretStore:', e && e.message ? e.message : e);
}

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { isCorsOriginAllowed } = require('./config/secrets');
const { verificarToken } = require('./middleware/auth');
const validarTerminalMobile = require('./middleware/validarTerminalMobile');

const app = express();
const PORT = process.env.PORT || 3001;
const { cspHeadersMiddleware } = require('./middleware/cspHeaders');

// Middleware
app.use((req, res, next) => {
  cors({
    origin(origin, callback) {
      if (isCorsOriginAllowed(origin, req.headers.host)) {
        return callback(null, true);
      }
      callback(new Error('Origem não permitida pelo CORS'));
    },
    credentials: true
  })(req, res, next);
});
// CSP canônica (sem unsafe-eval) — Electron também injeta via session.
app.use(cspHeadersMiddleware);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/ping', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/api/ping', (req, res) => {
    res.json({ status: 'ok' });
});

// PDV Universal congelado: a interface (HTML e assets) não é mais servida; /pdv é o PDV oficial.
// Deve vir antes do express.static, que serviria /pdv-universal/index.html e seus assets.
function caminhoDoPdvUniversalBloqueado(rawPath) {
  let p = String(rawPath || '');
  try { p = decodeURIComponent(p); } catch (_) { /* caminho malformado: usa o bruto */ }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  return /^\/pdv-universal(\/|$)/.test(p);
}
app.use((req, res, next) => {
  if (!caminhoDoPdvUniversalBloqueado(req.path)) return next();
  return res.redirect(302, '/pdv');
});

app.use(express.static(path.join(__dirname, '../frontend')));

// Branding oficial 1.0 — assets canônicos (Electron + Web)
const brandingRoot = path.join(__dirname, '../assets/branding');
app.use('/branding', express.static(brandingRoot));

// Compatibilidade: URL legada da logo
app.get('/shared/img/logo-cds-sistemas.png', (req, res) => {
  res.sendFile(path.join(brandingRoot, 'logo-oficial.png'));
});

function getWritableStoragePath() {
    if (process.platform === 'win32') {
      return path.join(
        process.env.PROGRAMDATA || 'C:\\ProgramData',
        'CDS Sistemas',
        'CDS Sistemas'
      );
    }
  
    return path.join(process.cwd(), 'dados-app');
  }
  
  // primeiro tenta no local correto (produção)
  app.use('/storage', express.static(path.join(getWritableStoragePath(), 'storage')));
  
  // fallback (para desenvolvimento)
  app.use('/storage', express.static(path.join(__dirname, '../storage')));

// Rotas públicas
const { router: authRouter } = require('./rotas/auth');
app.use('/api/auth', authRouter);

// Rota pública para configuração de fundo do login
const db = require('./database');
app.get('/api/configuracoes/login_background', (req, res) => {
    db.get("SELECT valor FROM configuracoes WHERE chave = 'login_background'", [], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ valor: row ? row.valor : null });
    });
});

const frontendRoot = path.join(__dirname, '../frontend');

// Login e módulos ERP/PDV (páginas HTML)
app.get('/login', (req, res) => {
    res.sendFile(path.join(frontendRoot, 'shared/login.html'));
});

app.get(['/cozinha', '/cozinha/'], (req, res) => {
    res.sendFile(path.join(frontendRoot, 'cozinha-tv/index.html'));
});

app.get(['/mobile', '/mobile/'], (req, res) => {
    res.sendFile(path.join(frontendRoot, 'mobile/index.html'));
});
app.get(['/mobile-pedido', '/mobile-pedido/'], (req, res) => {
    res.sendFile(path.join(frontendRoot, 'mobile-pedido/index.html'));
});
app.get(['/mobile-mesas', '/mobile-mesas/'], (req, res) => {
    res.sendFile(path.join(frontendRoot, 'mobile-mesas/index.html'));
});
app.get(['/mobile-pdv', '/mobile-pdv/'], (req, res) => {
    res.sendFile(path.join(frontendRoot, 'mobile-pdv/index.html'));
});
app.get(['/mobile-contagem', '/mobile-contagem/'], (req, res) => {
    res.sendFile(path.join(frontendRoot, 'mobile-contagem/index.html'));
});

app.get(['/erp', '/erp/'], verificarToken, (req, res) => {
    res.sendFile(path.join(frontendRoot, 'erp/index.html'));
});


// Rotas protegidas (API)
const produtosRoutes = require('./rotas/produtos');
const importacaoInicialProdutosRoutes = require('./rotas/importacao-inicial-produtos');
const searchRoutes = require('./rotas/search');
const intelligenceRoutes = require('./rotas/intelligence');
const agentRoutes = require('./rotas/agent');
const pluginsRoutes = require('./rotas/plugins');
const businessMonitorRoutes = require('./rotas/business-monitor');
const clientesRoutes = require('./rotas/clientes');
const comprasRoutes = require('./rotas/compras');
const categoriasRoutes = require('./rotas/categorias');
const subcategoriasRoutes = require('./rotas/subcategorias');
const marcasRoutes = require('./rotas/marcas');
const empresasRoutes = require('./rotas/empresas');
const vendasRoutes = require('./rotas/vendas');
const entregasRoutes = require('./rotas/entregas');
const faturamentoRoutes = require('./rotas/faturamento');
const centralFaturamentoRoutes = require('./rotas/centralFaturamento');
const pedidosRoutes = require('./rotas/pedidos');
const mesasRoutes = require('./rotas/mesas');
const cozinhaRoutes = require('./rotas/cozinha');
const financeiroRoutes = require('./rotas/financeiro');
const condicoesPagamentoRoutes = require('./rotas/condicoes-pagamento');
const configuracoesRoutes = require('./rotas/configuracoes');
const configuracaoRedeRoutes = require('./rotas/configuracao_rede');
const fiscalRoutes = require('./rotas/fiscal');
const nfeRoutes = require('./rotas/nfe');
const fornecedoresRoutes = require('./rotas/fornecedores');
const impressaoRoutes = require('./rotas/impressao');
const caixaRoutes = require('./rotas/caixa');
const caixasRoutes = require('./rotas/caixas');
const terminaisRoutes = require('./rotas/terminais');
const tefRoutes = require('./rotas/tef');
const pixRoutes = require('./rotas/pix');
const dashboardRoutes = require('./rotas/dashboard');
const misRoutes = require('./rotas/mis');
const bancarioRoutes = require('./rotas/bancario');
const contasReceberRoutes = require('./rotas/contas_receber');
const contasPagarRoutes = require('./rotas/contas_pagar');
const alertasRoutes = require('./rotas/alertas');
const licencaRoutes = require('./rotas/licenca');
const dfeRoutes = require('./rotas/dfe');
const dfeAuditoriaRoutes = require('./rotas/dfe-auditoria');
const centralEntradasRoutes = require('./rotas/central-entradas');
const monitoringRoutes = require('./monitoring/MonitoringRouter');
const equipamentosRoutes = require('./rotas/equipamentos');
const centralEquipamentosRoutes = require('./rotas/central-equipamentos');
const configuracoesAvancadasRoutes = require('./rotas/configuracoes_avancadas');
const plataformaRoutes = require('./rotas/plataforma');
const observabilidadeRoutes = require('./rotas/observabilidade');
const { exigirRecurso } = require('./middleware/validarRecursoImplantacao');
const configService = require('./services/configuracaoService');

configService.ensureConfigFile();
configService.reloadGlobalConfig();

const { createLazyRouter } = require('./boot/lazyService');

// RC11.3 — Grupo D (lazy): MIIP, laboratorio, engenharia reversa, auditoria, backup
const miipRoutes = createLazyRouter('miip', () => require('./rotas/miip'));
const auditoriaRoutes = createLazyRouter('auditoria', () => require('./rotas/auditoria'));
const laboratorioEquipamentosRoutes = createLazyRouter(
  'laboratorio-equipamentos',
  () => require('./rotas/laboratorioEquipamentos')
);
const engenhariaReversaRoutes = createLazyRouter(
  'engenharia-reversa',
  () => require('./rotas/engenhariaReversa')
);
const backupRoutes = createLazyRouter('backup', () => require('./rotas/backup'));


// Hotfix RC1 — ordem obrigatória sob /api: Auth → Licença → rotas (recurso)
const { apiAuthLicencaGate } = require('./middleware/apiAuthLicencaGate');
app.use('/api', apiAuthLicencaGate);

// Rotas de licença (públicas — gate libera /api/licenca)
app.use('/api/licenca', licencaRoutes);

app.use('/api/produtos/importacao-inicial', verificarToken, importacaoInicialProdutosRoutes);
app.use('/api/produtos', verificarToken, produtosRoutes);
app.use('/api/search', verificarToken, searchRoutes);
app.use('/api/intelligence', verificarToken, intelligenceRoutes);
app.use('/api/agent', verificarToken, agentRoutes);
app.use('/api/plugins', verificarToken, pluginsRoutes);
app.use('/api/business-monitor', verificarToken, businessMonitorRoutes);
app.use('/api/clientes', verificarToken, clientesRoutes);
app.use('/api/compras', verificarToken, comprasRoutes);
app.use('/api/miip', verificarToken, miipRoutes);
app.use('/api/categorias', verificarToken, categoriasRoutes);
app.use('/api/subcategorias', verificarToken, subcategoriasRoutes);
app.use('/api/marcas', verificarToken, marcasRoutes);
app.use('/api/empresas', verificarToken, empresasRoutes);
app.use('/api/atendimentos', verificarToken, require('./rotas/atendimentos'));
app.use('/api/pdv-universal', verificarToken, require('./rotas/pdv-universal'));
app.use('/api/estoque', verificarToken, require('./rotas/estoque'));
// Sprint 1 — rotas de entrega montadas antes das rotas genéricas de vendas
app.use('/api/vendas', verificarToken, validarTerminalMobile, entregasRoutes);
app.use('/api/vendas', verificarToken, validarTerminalMobile, vendasRoutes);
app.use('/api/faturamento', verificarToken, exigirRecurso('faturamento'), faturamentoRoutes);
app.use('/api/central-faturamento', verificarToken, exigirRecurso('nfe'), centralFaturamentoRoutes);
app.use('/api/pedidos', verificarToken, exigirRecurso('pedidos'), pedidosRoutes);
app.use('/api/mesas', verificarToken, exigirRecurso('pedidos'), mesasRoutes);
app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);

// Sprint 3.9 — PDV só existe se módulo licenciado (princípio da invisibilidade)
const { responderModuloNaoLicenciado } = require('./middleware/errosLicenciamento');
app.get(['/pdv', '/pdv/'], verificarToken, (req, res) => {
  if (!configService.recursoHabilitado('pdv')) {
    return responderModuloNaoLicenciado(res, 'pdv');
  }
  res.sendFile(path.join(frontendRoot, 'pdv/index.html'));
});
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/mis', verificarToken, misRoutes);
app.use('/api/bancario', verificarToken, bancarioRoutes());
app.use('/api/financeiro', verificarToken, financeiroRoutes);
app.use('/api/condicoes-pagamento', verificarToken, condicoesPagamentoRoutes);
app.use('/api/mie', verificarToken, require('./rotas/mie'));
app.use('/api/contas-receber', verificarToken, contasReceberRoutes);
app.use('/api/contas-pagar', verificarToken, contasPagarRoutes);
app.use('/api/configuracoes', verificarToken, configuracoesRoutes);
app.use('/api/configuracao-rede', verificarToken, configuracaoRedeRoutes);
app.use('/api/configuracoes-avancadas', verificarToken, configuracoesAvancadasRoutes);
app.use('/api/plataforma', verificarToken, plataformaRoutes);
// RC12.2 — summary autenticado via gate; POST /rum público (observe-only)
app.use('/api/observabilidade', observabilidadeRoutes);
app.use('/api/fiscal', verificarToken, exigirRecurso('fiscal'), fiscalRoutes);
app.use('/api/nfe', verificarToken, exigirRecurso('nfe'), nfeRoutes);
app.use('/api/fornecedores', verificarToken, fornecedoresRoutes);
app.use('/api/impressao', verificarToken, impressaoRoutes);
app.use('/api/caixa', verificarToken, validarTerminalMobile, caixaRoutes);
app.use('/api/caixas', verificarToken, exigirRecurso('multiCaixa'), caixasRoutes);
app.get('/api/terminais/auto', terminaisRoutes.registrarTerminalAuto);
app.get('/api/terminais/auto/offline', terminaisRoutes.registrarTerminalOffline);
app.put(
  '/api/terminais/auto/nome',
  verificarToken,
  terminaisRoutes.exigirSuperAdminTerminal,
  terminaisRoutes.atualizarNomeTerminalPdv
);
app.post(
  '/api/terminais/auto/nome',
  verificarToken,
  terminaisRoutes.exigirSuperAdminTerminal,
  terminaisRoutes.atualizarNomeTerminalPdv
);
app.use('/api/terminais', verificarToken, exigirRecurso('multiCaixa'), terminaisRoutes);
app.use('/api/backup', verificarToken, backupRoutes);
app.use('/api/tef', verificarToken, tefRoutes);
app.use('/api/pix', verificarToken, pixRoutes);
app.use('/api/alertas', verificarToken, alertasRoutes);
app.use('/api/auditoria', verificarToken, auditoriaRoutes);
app.use('/api/dfe', verificarToken, exigirRecurso('fiscal'), dfeRoutes);
app.use('/api/dfe-auditoria', verificarToken, exigirRecurso('fiscal'), dfeAuditoriaRoutes);
app.use('/api/central-entradas', verificarToken, exigirRecurso('fiscal'), centralEntradasRoutes);
app.use('/api/monitoring', verificarToken, monitoringRoutes);
app.use('/api/equipamentos', verificarToken, equipamentosRoutes);
app.use('/api/central-equipamentos', verificarToken, centralEquipamentosRoutes);
app.use('/api/monitoramento-equipamentos', verificarToken, require('./rotas/monitoramento-equipamentos'));
app.use('/api/integracao-equipamentos', verificarToken, require('./rotas/integracao-equipamentos'));
app.use('/api/laboratorio-equipamentos', verificarToken, laboratorioEquipamentosRoutes);
app.use('/api/engenharia-reversa', verificarToken, engenhariaReversaRoutes);

// Rota principal — redireciona para o ERP modular
app.get('/', verificarToken, (req, res) => {
    res.redirect('/erp');
});

// Rota para arquivos estáticos (não proteger)
app.get('*.js', (req, res, next) => {
    next();
});
app.get('*.css', (req, res, next) => {
    next();
});
app.get('*.png', (req, res, next) => {
    next();
});
app.get('*.jpg', (req, res, next) => {
    next();
});

// Error handler — JSON inválido
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'Requisição inválida.' });
    }
    next(err);
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Erro:', err);
    if (err && String(err.message || '').includes('CORS')) {
        return res.status(403).json({ error: 'Origem não permitida pelo CORS' });
    }
    res.status(500).json({ error: 'Erro interno do servidor' });
});
// Iniciar servidor somente após o banco estar pronto (evita SQLITE_BUSY no login do PDV)
// RC11.2 — Boot não bloqueante: listen() antes dos serviços Grupo B (background).
const server = http.createServer(app);
module.exports = server;

const bootT0 = Date.now();
function bootLog(evento, extra = {}) {
    const payload = {
        tag: 'BOOT',
        evento,
        ms: Date.now() - bootT0,
        ...extra
    };
    console.log(JSON.stringify(payload));
    // RC12.1 — observe-only (nunca bloqueia / nunca propaga erro)
    try {
        require('./observabilidade/adapters/bootAdapter').publishBootEvent(evento, payload);
    } catch (_) { /* ignore */ }
}

bootLog('BOOT');

async function inicializarMotorEquipamentos() {
    const motorEquipamentos = require('./motores/equipamentos');
    const monitorService = require('./motores/equipamentos/monitor/MonitorService');
    const driverManager = require('./motores/equipamentos/core/DriverManager');
    await motorEquipamentos.inicializar();
    driverManager.obterRelatorioCarregamento();
    monitorService.iniciar();
    try {
        const integracaoEquipamentos = require('./services/equipamentos-integracao');
        integracaoEquipamentos.iniciar();
        console.log('Integração corporativa de Equipamentos RC5 iniciada.');
    } catch (err) {
        console.error('Falha ao iniciar integração de equipamentos:', err.message);
        throw err;
    }
    console.log('Motor de Equipamentos inicializado (fila, drivers, monitor).');
}

async function inicializarFinanceiroVendas() {
    const { sincronizarFinanceiroVendasCanceladas } = require('./services/vendas/VendaFinanceiroService');
    const resultado = await sincronizarFinanceiroVendasCanceladas();
    if (resultado.registros_corrigidos > 0) {
        console.log(
            `Financeiro: ${resultado.registros_corrigidos} registro(s) sincronizado(s) em ${resultado.vendas} venda(s) cancelada(s).`
        );
    }
}

async function inicializarCentralSync() {
    const centralSyncBackground = require('./motores/central-entradas/services/CentralSyncBackgroundService');
    await centralSyncBackground.iniciar();
}

async function inicializarCentralHealth() {
    const health = require('./motores/central-entradas/health');
    await health.iniciar();
}

async function inicializarNfeRetoma() {
    const nfeOperacional = require('./services/fiscal/nfeOperacionalService');
    await nfeOperacional.garantirSchemaOperacional();
    await nfeOperacional.retomarConsultasPendentes();
    console.log('[NFe] Consultas automáticas pendentes retomadas.');
}

async function executarPassoBackground(nome, fn) {
    const t0 = Date.now();
    try {
        await fn();
        bootLog('BACKGROUND STEP OK', { step: nome, stepMs: Date.now() - t0 });
        return true;
    } catch (err) {
        bootLog('BACKGROUND ERROR', {
            step: nome,
            stepMs: Date.now() - t0,
            erro: err && err.message ? err.message : String(err)
        });
        console.error(`Falha no background [${nome}]:`, err && err.message ? err.message : err);
        return false;
    }
}

/**
 * Grupo B (RC11.1) — pós-listen, não bloqueia HTTP/login.
 * Falha individual não derruba o servidor.
 */
async function iniciarServicosBackgroundGrupoB() {
    bootLog('BACKGROUND START');
    const tBg = Date.now();
    await executarPassoBackground('financeiro-sync', inicializarFinanceiroVendas);
    await executarPassoBackground('equipamentos-monitor', inicializarMotorEquipamentos);
    await executarPassoBackground('central-sync', inicializarCentralSync);
    await executarPassoBackground('central-health', inicializarCentralHealth);
    await executarPassoBackground('nfe-retoma', inicializarNfeRetoma);
    bootLog('BACKGROUND READY', { backgroundMs: Date.now() - tBg });
}

function registrarEncerramentoBackground() {
    const encerrarBackground = () => {
        try {
            const centralSyncBackground = require('./motores/central-entradas/services/CentralSyncBackgroundService');
            centralSyncBackground.parar();
        } catch { /* ignore */ }
        try {
            const health = require('./motores/central-entradas/health');
            health.parar();
        } catch { /* ignore */ }
        // RC14.14.8 — fecha sockets de equipamentos ao encerrar ERP/servidor
        try {
            const cm = require('./motores/equipamentos/connection/ConnectionManager');
            if (cm && typeof cm.closeAll === 'function') {
                cm.closeAll().catch(() => {});
            }
        } catch { /* ignore */ }
    };
    process.on('SIGTERM', encerrarBackground);
    process.on('SIGINT', encerrarBackground);
}

db.whenReady(async (readyErr) => {
    if (readyErr) {
        bootLog('DATABASE ERROR', { erro: readyErr.message });
        console.error('Servidor não iniciado: banco indisponível.', readyErr.message);
        process.exit(1);
        return;
    }

    bootLog('DATABASE READY');

    // Leve / gate de produto — mantido antes do listen (não bloqueia de forma relevante)
    try {
        const { hidratarFlagDoBanco, MIP_VERSION } = require('./motores/produto-identidade');
        const mipOn = await hidratarFlagDoBanco(db);
        console.log(`[MIP] v${MIP_VERSION} produto_identidade_enabled = ${mipOn ? 'ON' : 'OFF'}`);
        bootLog('MIP FLAG READY', { enabled: !!mipOn });
    } catch (err) {
        console.error('Falha ao hidratar flag MIP:', err.message);
        bootLog('BACKGROUND ERROR', { step: 'mip-flag', erro: err.message });
    }

    registrarEncerramentoBackground();

    server.listen(PORT, () => {
        bootLog('HTTP LISTENING', { port: Number(PORT) });
        console.log(`Servidor rodando na porta ${PORT}`);
        console.log(`Acesse: http://localhost:${PORT}/login`);
        console.log('Configuração avançada:', configService.getRecursos());

        if (process.env.CDS_TEST_ISOLATION !== '1') {
            const { criarServidorKds, interfacesIpv4, validarNomeDnsLocal } = require('./cozinha-rede-local');
            const portaKds = Number(process.env.CDS_KDS_LAN_PORT || 3002);
            let nomeDnsKds = null;
            let erroDnsKds = null;
            try {
                nomeDnsKds = validarNomeDnsLocal(process.env.CDS_KDS_LAN_HOST);
            } catch (err) {
                erroDnsKds = err;
            }
            if (erroDnsKds) {
                console.error('[KDS REDE] Acesso de rede não iniciado:', erroDnsKds.message);
            } else if (!Number.isInteger(portaKds) || portaKds < 1 || portaKds > 65535) {
                console.error('[KDS REDE] Porta inválida; acesso de rede não iniciado.');
            } else {
                let discovery = null;
                const servidorKds = criarServidorKds(app, interfacesIpv4, nomeDnsKds,
                    () => discovery && discovery.hostname());
                servidorKds.on('error', (err) => {
                    console.error('[KDS REDE] Falha ao iniciar acesso de rede:', err.message);
                });
                servidorKds.listen(portaKds, '0.0.0.0', () => {
                    console.log(`[KDS REDE] Local: http://127.0.0.1:${portaKds}/cozinha`);
                    if (nomeDnsKds) console.log(`[KDS REDE] DNS local configurado: http://${nomeDnsKds}:${portaKds}/cozinha`);
                    for (const rede of interfacesIpv4()) {
                        console.log(`[KDS REDE] ${rede.nome}: http://${rede.endereco}:${portaKds}/cozinha`);
                    }
                    try {
                        const { criarDiscoveryKds } = require('./services/cdsNetworkDiscovery');
                        const { isCozinhaOperacional } = require('./utils/cozinhaSchema');
                        const licencaService = require('./services/licencaService');
                        discovery = criarDiscoveryKds({
                            servidor: servidorKds,
                            diretorio: path.join(db.dbDir, 'config'),
                            obterInterfaces: interfacesIpv4,
                            autorizado: () => new Promise((resolve, reject) => {
                                if (!configService.recursoHabilitado('pedidos') || !isCozinhaOperacional()) {
                                    resolve(false);
                                    return;
                                }
                                db.get('SELECT codigo_licenca, data_expiracao, ultima_execucao FROM licenca ORDER BY id ASC LIMIT 1', [], (err, licenca) => {
                                    if (err) return reject(err);
                                    resolve(!!licenca && !!licenca.codigo_licenca
                                        && !licencaService.verificarDataAlterada(licenca.ultima_execucao)
                                        && licencaService.diasRestantes(licenca.data_expiracao) > 0);
                                });
                            })
                        });
                        void discovery.iniciar().catch(() => {});
                    } catch (err) {
                        console.error('[CDS DISCOVERY] Não iniciado:', err.message);
                    }
                });
                const pararDiscovery = () => {
                    if (discovery) return discovery.parar();
                    return Promise.resolve();
                };
                servidorKds.on('close', () => { void pararDiscovery().catch(() => {}); });
                server.on('close', () => servidorKds.close());
                process.on('SIGTERM', () => { void pararDiscovery().catch(() => {}); });
                process.on('SIGINT', () => { void pararDiscovery().catch(() => {}); });
                if (process.versions.electron) {
                    const electronApp = require('electron').app;
                    if (electronApp) electronApp.once('before-quit', (event) => {
                        if (!discovery) return;
                        event.preventDefault();
                        const limite = new Promise((resolve) => setTimeout(resolve, 2000));
                        void Promise.race([pararDiscovery(), limite]).catch(() => {}).then(() => electronApp.quit());
                    });
                }
            }
        }

        // Desacoplado do boot: não impede o listen nem a aceitação de conexões
        setImmediate(() => {
            // Backup local diário 23:59 + primeira entrada do dia
            try {
                require('./services/backupAutomaticoLocal').iniciarBackupAutomaticoLocal();
            } catch (errBackup) {
                console.error('[BACKUP] Falha ao iniciar automático:', errBackup && errBackup.message);
            }
            // RC12.1 — Observability Bus adapters (observe-only)
            try {
                require('./observabilidade').iniciar();
            } catch (_) { /* ignore */ }
            // CIA-APPS — plugins opcionais (falha nunca derruba boot)
            try {
                const { bootstrapPlugins } = require('./plugins');
                void bootstrapPlugins({ db }).then((r) => {
                    if (r && r.ok) bootLog('CIA-APPS READY', { plugins: (r.results || []).length });
                    else bootLog('CIA-APPS SKIP', { erro: r && r.error });
                }).catch(() => { /* ignore */ });
            } catch (_) { /* ignore */ }
            void iniciarServicosBackgroundGrupoB();
        });
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Porta ${PORT} já está em uso. Pare o processo que usa a porta ou escolha outra porta.`);
            console.error(`No Windows, use: set PORT=3001 && npm start`);
            process.exit(1);
        }
        console.error('Erro ao iniciar o servidor:', err);
        process.exit(1);
    });
});
