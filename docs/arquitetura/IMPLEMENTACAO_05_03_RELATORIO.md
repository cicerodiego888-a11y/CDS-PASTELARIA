# Relatório — Sprint 05.03

## Tela principal do PDV Universal

### 1. Arquivos criados

- `frontend/pdv-universal/index.html`
- `frontend/pdv-universal/pdv-universal.js`
- `frontend/pdv-universal/pdv-universal.css`
- `tests/pdv-universal/tela-principal-05-03.test.js`
- `docs/arquitetura/IMPLEMENTACAO_05_03_TELA_PRINCIPAL_PDV_UNIVERSAL.md`
- `docs/arquitetura/IMPLEMENTACAO_05_03_RELATORIO.md`

### 2. Arquivos alterados

- `backend/server.js` — rota `GET /pdv-universal` (não altera `GET /pdv`)
- roadmap V1

### 3. Contexto

GET oficial no load. Sem modo inventado.

### 4. EMPRESA_UNICA

Mostra empresa resolvida ou exige seleção (capabilities + `exige_selecao`).

### 5. MULTIEMPRESA

Aceita empresa null; painel de empresas no atendimento vazio.

### 6. Seleção

PUT oficial + GET. Lista só do backend.

### 7. Capabilities

`aplicarCapabilities` controla seletor, painel multiempresa e checkout bloqueado.

### 8. Fora do escopo

Carrinho, produto, venda, pagamento, TEF, NFC-e, MUV visual.

### 9. Testes

`tela-principal-05-03` — **15/15**

### 10. Regressão

05.01, 05.02 e suíte crítica de vendas/MUV (rodada no ambiente).

### 11. Limitações

Tela estrutural. Busca desabilitada. Sem teste manual no browser/Electron nesta sessão (sem servidor de UI aberto aqui). Abrir: autenticar e acessar `/pdv-universal`.

### 12. Próxima sprint (não iniciada)

**05.04** — carrinho universal + identificação da empresa por item.
