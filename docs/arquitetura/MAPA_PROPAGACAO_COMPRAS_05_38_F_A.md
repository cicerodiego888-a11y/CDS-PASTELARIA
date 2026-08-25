# MAPA DE PROPAGAÇÃO — Compras 05.38.F.A

**Classificação:** SOMENTE LEITURA  
**Data:** 2026-08-24

---

## 1. Origens reais de criação de compra (comprovadas)

| # | ORIGEM | ENTRADA | PERSISTE COMPRA? |
|---|--------|---------|------------------|
| O1 | Compra manual ERP | UI `compras.js` → `POST /api/compras` | Sim |
| O2 | Central de Entradas → abrir compra | `POST /api/central-entradas/:id/abrir-compra` → sessionStorage → tela Compras → `POST /api/compras` + `central_documento_id` | Sim (mesmo INSERT) |
| O3 | Uso/consumo / NF avulsa | Mesmo `POST /api/compras` com `entradaSimplificada` | Sim (sem estoque) |
| O4 | Parse XML em Compras | `POST /api/compras/parse-xml` | **Não** — HTTP 410 deprecated |
| O5 | MIIP / Central Review | Não criam compra; preenchem parse/status; compra nasce em O2→O1 | Indireto |
| O6 | Serviços internos `ComprasService` | **Não encontrado** arquivo `ComprasService.js` de domínio | — |
| O7 | INSERT paralelo em outros módulos | Busca: **único** `INSERT INTO compras` em `backend/rotas/compras.js` | — |

**Conclusão:** há **uma única escrita** de compra no sistema; origens UI diferem, o insert é o mesmo.

---

## 2. Fluxo canônico (todas as origens que gravam)

```
ORIGEM (manual | Central)
  ↓
Frontend ERP compras.js
  $.ajax POST /api/compras  (+ X-Empresa-Id via CdsEmpresaContexto se cds_empresa_id)
  ↓
verificarToken (server.js)
  ↓
criarMiddlewareContextoEmpresa(db)   // obrigatorio=false → pode ficar null
  ↓
router.post('/') em compras.js
  ↓
INSERT INTO compras (...)            // SEM empresa_id
  ↓
[se normal] processarItensCompra
  → INSERT compras_itens
  → creditarEstoqueItemCompra(empresaId do req | COMPAT legado)
  → UPDATE produtos (preço/cadastro)
  ↓
garantirEmpresaIdParaFinanceiroCompra(req)
  → FinanceiroEmpresaContextoService se req.empresaId ausente
  ↓
criarFinanceiroCompra({ ..., empresa_id })
  → DELETE/INSERT financeiro com empresa_id
  ↓
[se central_documento_id] vincularDocumentoCentralAposCompra
  → CentralComprasBridgeService.vincularCompra (sem empresaId da compra)
  ↓
COMMIT
```

---

## 3. Central → Compra (detalhe 05.38.E)

```
central_entradas_documentos.empresa_id
  ↓
CentralComprasBridgeService.montarPayloadAbrirCompra
  → dadosCompra.empresa_id / empresaId no payload JSON
  ↓
Frontend: sessionStorage + abrirCompraDesdeCentralEntradas
  → NÃO reenvia empresa_id no POST (compras.js sem referências a empresaId)
  ↓
Contexto HTTP = X-Empresa-Id da sessão ERP (CdsEmpresaContexto)
  ↓
INSERT compras (sem empresa_id)
  ↓
Estoque/Financeiro usam req.empresaId (ou resolução financeira)
  ↓
vincularCompra(documentoId, compraId, { usuarioId })
  → exigirDocumentoCompraMesmaEmpresa(doc.empresaId, doc.empresaId)
     quando compraEmpresaId é null → validação NO-OP se documento tem empresa
```

**Quebra de cadeia comprovada:** `documento.empresa_id` pode divergir do `req.empresaId` usado no estoque/financeiro; a compra não guarda empresa para auditoria posterior.

---

## 4. Matriz de fronteiras (classificação)

| Fronteira | empresa_id existe? | Origem | Persistência | Validação | Risco cruzamento | Classe |
|-----------|-------------------|--------|--------------|-----------|------------------|--------|
| Origem → Compra | Não na tabela | Header / body / null | **Não** | Middleware opcional | Alto MULTI | **R6 AUSENTE** (persistência) / **R3 PARCIAL** (req) |
| Compra → Estoque | Na operação | `empresaIdDoReqCompra(req)` | `estoque_empresa` se empresa; senão COMPAT→`produtos` | Porta pública | Alto se null ou errado | **R3 PARCIAL** |
| Compra → Financeiro | No lançamento | req ou ContratoOperacional | `financeiro.empresa_id` | Obrigatório no insert | Médio — pode ≠ estoque se fontes diferirem | **R2 CONECTAR** |
| Compra → Central | Doc sim / compra não | Doc 05.38.E | `compra_id` no doc | Vincular sem empresa da compra | Alto | **R3 PARCIAL** |
| Consulta listagem | Não | — | — | Sem filtro empresa | Alto MULTI | **R6 AUSENTE** |
| Cancelamento | Operacional | `req.empresaId` no débito | UPDATE compra + financeiro por `compra_id` | Estoque por empresa se header | Alto (cancelar compra “de outra empresa”) | **R3 PARCIAL** |

Legenda: R1 reutilizável · R2 conectar · R3 parcial · R4 centralizar · R5 duplicado · R6 ausente

---

## 5. EMPRESA_SIMPLES vs MULTIEMPRESA (comportamento atual)

| Aspecto | EMPRESA_SIMPLES | MULTIEMPRESA |
|---------|-----------------|--------------|
| Header X-Empresa-Id | Opcional; frequentemente preenchido se 1 empresa no seletor | Esperado via seletor |
| Middleware | Aceita null | Aceita null (`obrigatorio: false`) |
| Financeiro sem header | Resolve via `ContratoOperacionalService` | Exige contexto → erro |
| Estoque sem header | COMPAT legado em `produtos` | COMPAT legado (não isola `estoque_empresa`) |
| Compra persistida | Sem empresa | Sem empresa |
| Listagem | Todas as compras | Todas as compras (sem filtro) |

---

## 6. O que impede compra manual com contexto errado em MULTIEMPRESA?

**Hoje, de forma frágil:**

1. `CdsEmpresaContexto` anexa `X-Empresa-Id` no `$.ajaxSetup` **se** `cds_empresa_id` existir.
2. Middleware valida empresa ativa + vínculo `usuario_empresas`.
3. Financeiro em MULTI **bloqueia** ausência de contexto.
4. Estoque **não** exige empresa (`exigirEmpresa` default false) → COMPAT legado.

**Não impede:**

- Usuário com duas empresas selecionar B e lançar NF da Central destinada a A.
- Listar/cancelar compra criada sob A estando em B (lookup só por `id`).
- Persistência da “empresa correta” na compra (inexistente).
