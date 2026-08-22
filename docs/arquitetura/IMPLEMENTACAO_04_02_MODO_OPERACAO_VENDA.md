# Implementação 04.02 — Configuração do modo de operação de venda

**Data:** 2026-08-21 · **Sprint:** 04.02 · **Motor:** Universal de Vendas (MUV)

## 1. Arquivos auditados

| Área | Arquivo | Achado |
|---|---|---|
| Persistência | `backend/services/configuracaoService.js` | Configuração da instalação em JSON, não em tabela SQL |
| Caminho | `getPersistentConfigDir()` → `{DB_DIR}/config/configuracoes.json` | `DB_DIR` ou `ProgramData/MercantilFiscal/dados` |
| Default | objeto `DEFAULT` | Merge em `readConfig` via `Object.assign({}, DEFAULT, normalizeConfig(parsed))` |
| Bootstrap | `ensureConfigFile` / `migrateLegacyConfig` | Cria arquivo se ausente; **não** inseria chaves novas em arquivo já existente |
| Idempotência | escrita só se o arquivo não existe (legado) | Chave nova exigiu bootstrap específico |
| Inválidos (padrão legado) | `normalizeModoConfirmacaoFiscal` | Coerce silencioso (`MANUAL` ou `TEF`) |
| Cache | `reloadGlobalConfig` → `global.CONFIGURACAO_AVANCADA` | Sem cache em memória próprio da leitura |
| Consumidores | PDV, fiscal, faturamento, entregas, MPFC, licenciamento, `rotas/configuracoes_avancadas.js` | `readConfig` / `getRecursos` / `saveConfig` |
| Porta de venda | `VendaApplicationService.js` | Delegava PDV/FATURAMENTO/NF_AVULSA; demais reconhecem sem concluir |
| Contrato 04.01 | `backend/motores/muv/contratos.js` | `ModoOperacaoVenda` já existia; ainda não persistido |

**Decisão:** reutilizar `configuracoes.json`. Não criar tabela paralela.

## 2. Onde a configuração é persistida

Chave oficial: `modo_operacao_venda`

Arquivo: `{DB_DIR}/config/configuracoes.json` (mesma persistência de `tipoImplantacao`, `modoOperacao`, módulos, etc.)

Valores: `EMPRESA_UNICA` | `MULTIEMPRESA`

## 3. Bootstrap

`bootstrapModoOperacaoVenda()` (chamado por `ensureConfigFile`):

- arquivo novo ou chave ausente/vazia → grava `EMPRESA_UNICA`
- chave já preenchida (`EMPRESA_UNICA`, `MULTIEMPRESA` ou até inválido) → **não sobrescreve**
- não reseta outras chaves
- não cria empresa padrão / não usa empresa 1

Idempotente e não destrutivo.

## 4. Default

`DEFAULT_MODO_OPERACAO_VENDA = EMPRESA_UNICA`

`configuracaoService.DEFAULT.modo_operacao_venda` usa o mesmo valor.

`validarModoOperacaoVenda` **não** aplica default: null/undefined/inválido são erro.

`resolverModoOperacaoVenda` (04.01) continua tratando fonte **ausente** como `EMPRESA_UNICA`.

## 5. Valor inválido persistido

Padrão de segurança **diferente** de `modo_confirmacao_fiscal` (que coage para TEF).

| Situação | Comportamento |
|---|---|
| Chave ausente | bootstrap → `EMPRESA_UNICA` |
| `EMPRESA_UNICA` / `MULTIEMPRESA` | devolvido |
| Valor inválido no arquivo | `obterModoOperacaoVenda` lança `MODO_OPERACAO_VENDA_INVALIDO` |
| Invalid persistido + bootstrap | **não** é reescrito para o default (corrupção visível) |

Não se escolhe `MULTIEMPRESA` por fallback. Não se finge `EMPRESA_UNICA` operacional quando o arquivo está corrompido.

Na porta HTTP: HTTP 500 com `code: MODO_OPERACAO_VENDA_INVALIDO`.

## 6. Ponto único de resolução

`backend/motores/muv/modoOperacaoVenda.js`:

```
resolverModoOperacaoVendaAtivo()
        │
        ▼
executarNoModoOperacaoVenda(modo, { EMPRESA_UNICA, MULTIEMPRESA })
        │
        ├── EMPRESA_UNICA → executor legado
        └── MULTIEMPRESA → executor próprio ou MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO
```

Sem `if (modo === 'MULTIEMPRESA')` em rotas, PDV, pagamentos, estoque ou Motor Comercial.

Express `next` passado a `criarVenda(req, res, next)` é ignorado.

## 7. Integração no VendaApplicationService

A porta resolve o modo **antes** da política de origem.

- `EMPRESA_UNICA` → fluxo 2.2 inalterado (PDV/FATURAMENTO/NF_AVULSA concluem; demais reconhecem sem concluir)
- `MULTIEMPRESA` → 200 `{ venda_concluida: false, code: MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO }` — **não** chama `VendaPagamentoService`

`req.vendaContext.modo_operacao_venda` recebe o modo resolvido.

## 8. Intocado

Frontend/PDV/atalhos, schema `vendas` / `vendas_itens` / `estoque_empresa`, dual-write, COMPAT, Motor Comercial, MTS, TEF, fiscal, caixa, pagamentos, tabela atendimento, orquestração multiempresa.

## 9. Testes

`tests/muv/modo-operacao-venda-04-02.test.js` — 14 casos obrigatórios.

## 10. Próxima Sprint recomendada

**04.03** — executor `MULTIEMPRESA` (ATENDIMENTO + operações empresariais) sem ainda fechar checkout dividido. Não iniciada nesta entrega.
