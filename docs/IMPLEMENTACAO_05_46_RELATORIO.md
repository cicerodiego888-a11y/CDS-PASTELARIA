# SPRINT 05.46

## OBJETIVO

Garantir que NFC-e da venda use somente a configuração fiscal (certificado, CSC, ID CSC, ambiente, série, numeração) da empresa em `vendas.empresa_id`. O contexto atual só autoriza.

## CAUSA DOS RISCOS

`getFiscalConfig()` sem `empresaId` lê a tabela `configuracoes` (perfil global). Os callers PDV/HTTP da NFC-e **não passavam** a empresa da venda:

- `emitirPorVendaId(vendaId)` usava `opcoes.empresaId` ou caía no global
- `cancelarNfce` chamava `getFiscalConfig()` na primeira linha
- `GET /fiscal/notas` listava NFC-e de todas as empresas

A estrutura por empresa (`empresas_configuracao_fiscal`) já existia desde 04.08. O buraco era **ownership na operação da venda**.

## ARQUIVOS AUDITADOS

Emissão: `emissor.js`, `VendaFiscalService.js`, `rotas/fiscal.js`, `FiscalizarAtendimentoService.js`  
Cancelamento: `cancelarNfce.js`, `VendaCancelamentoService.js`, `cancelamentoRuntime.js`  
Config: `configService.js`, `empresasConfiguracaoFiscal.js`, `qrcode.js`, `certificateService.js`  
Leituras: `GET /notas`, `GET /notas/:id`, `GET /danfe/venda/:vendaId`  
Classificados C (não alterados): NF-e 55, DistDFe, `GET/PUT /fiscal/config`, upload PFX sem empresa  
Classificados E: `backend/teste_cancelar.js`

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/fiscal/FiscalEmpresaContextoService.js` | **Novo** — resolução central |
| `backend/services/fiscal/emissor.js` | Empresa da venda antes de numerar/transmitir |
| `backend/services/fiscal/cancelarNfce.js` | Config da empresa da venda |
| `backend/services/vendas/VendaFiscalService.js` | Passa `empresaIdContexto` |
| `backend/services/vendas/VendaCancelamentoService.js` | Contexto no cancelamento NFC-e |
| `backend/rotas/fiscal.js` | Autorização + 404 cruzado + listagem isolada |
| `tests/fiscal/isolamento-nfce-empresa-05-46.test.js` | **Novo** |
| `tests/fiscal/configuracao-fiscal-empresa-real-05-18-3.test.js` | Assert do caminho real atualizado |
| Docs 05.46 | Inventário, ownership, relatório |

## FLUXOS DE EMISSÃO

1. PDV pós-venda → `VendaFiscalService.emitirFiscalSeSolicitado` / `responderVendaComFiscal`
2. HTTP `POST /api/fiscal/emitir/venda/:vendaId`
3. MUV `FiscalizarAtendimentoService` (já passava `empresaId` da operação; agora o emissor exige igualdade com `vendas.empresa_id`)

## FLUXOS DE CANCELAMENTO

1. Cancelar venda → `cancelarNfceAutorizadaVenda` → `cancelarNfce`
2. HTTP `POST /api/fiscal/notas/:id/cancelar`

## CERTIFICADO

**Antes:** `getFiscalConfig()` → `fiscal_certificado_path` global.  
**Depois:** `obterCertificadoDaEmpresa({ empresaId: venda.empresa_id })` → `empresas_configuracao_fiscal.certificado_path`. Mecanismo PFX inalterado.

## CSC

**Antes:** `fiscal_token_csc` / `fiscal_id_csc` globais.  
**Depois:** `resolverCredenciaisNfceDaEmpresa` → `token_csc` / `id_csc` da empresa. Sem CSC → `CONFIGURACAO_FISCAL_EMPRESA_INCOMPLETA`. Sem fallback.

## SÉRIE / NUMERAÇÃO

Inalterada a regra fiscal. Com `empresaId`, `incrementaNumeroFiscal` usa `MAX` filtrado por `nfce_notas.empresa_id` + `numero_atual` da empresa. A emissão da venda agora **sempre** passa esse id.

## FALLBACKS ELIMINADOS

- `getFiscalConfig()` sem empresa em `cancelarNfce` e `emitirPorVendaId`
- Fallback `FROM caixa` / última config: já não existia no emissor; o equivalente era o perfil **GLOBAL**
- `opcoes.empresaId` como fonte da config (agora só autorização; ownership = venda)

## CLASSES A/B/C/D/E

Ver `docs/arquitetura/INVENTARIO_FISCAL_EMPRESARIAL_05_46.md`. D corrigidos: emissão PDV/HTTP, cancelamento, DANFE, listagem de notas. C mantidos: perfil global admin, NF-e 55, DistDFe.

## VENDAS LEGADAS

`empresa_id IS NULL` → `EMPRESA_OWNERSHIP_REQUIRED` antes de numerar ou transmitir.

## TESTES

| Suite | Executados | OK | Falha |
|-------|------------|----|-------|
| `tests/fiscal/isolamento-nfce-empresa-05-46.test.js` | 21 | 21 | 0 |
| `tests/muv/contexto-fiscal-multiempresa-04-08.test.js` | 30 | 30 | 0 |
| `tests/fiscal/rc7104-estabilizacao-nfce.test.js` | 20 | 20 | 0 |
| `tests/fiscal/fiscal-cancelamento-runtime.test.js` | 13 | 13 | 0 |
| `tests/fiscal/configuracao-fiscal-empresa-real-05-18-3.test.js` | 9 | 9 | 0 |
| `tests/vendas/ownership-cancelamento-devolucao-05-42.test.js` | 9 | 9 | 0 |
| **Total desta verificação** | **102** | **102** | **0** |

## RISCOS REMANESCENTES

- NF-e modelo 55 (emissão, cancelamento, devolução) ainda usa `getFiscalConfig()` global
- DistDFe / Central de Entradas não são NFC-e da venda (05.43 cobre persistência DistDFe)
- Plataforma Fiscal (`/api/fiscal/config`) permanece perfil global intencional (EMPRESA_UNICA)
- `GET /api/fiscal/notas` em MULTIEMPRESA exige contexto (`X-Empresa-Id` ou contrato EMPRESA_SIMPLES)
- Venda nova com `empresa_id` exige linha em `empresas_configuracao_fiscal` — sem essa linha a NFC-e falha em vez de usar o global (comportamento exigido)

## PRÓXIMA PRIORIDADE ARQUITETURAL

Isolamento empresarial da **NF-e 55** (emissão, cancelamento, devolução de venda/compra) — mesmo padrão: `vendas.empresa_id` → configuração da empresa → certificado. Não iniciar automaticamente.
