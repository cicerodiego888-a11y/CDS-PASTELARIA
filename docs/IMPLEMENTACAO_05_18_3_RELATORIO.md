# Relatório — Sprint 05.18.3

Validação do encadeamento real da configuração fiscal por empresa.

## ESTADO

**ESTADO B — IMPLEMENTAÇÃO TÉCNICA CONCLUÍDA, VALIDAÇÃO VISUAL/OPERACIONAL PENDENTE**

Não houve emissão contra SEFAZ nem clique no ERP. Transporte mockado.

## Tabela

| OPERAÇÃO | CAMPO | EMPRESA | AMBIENTE | ORIGEM | CONSOME | STATUS |
|---|---|---|---|---|---|---|
| Autorização NFC-e | ws_autorizacao_homologacao / _producao | A ou B | do cadastro | CONFIGURAÇÃO DA EMPRESA | emissor.js → entregarUrlsAoTransporte | ATIVO |
| QRCode | csc_qrcode_url_* | A ou B | do cadastro | CONFIGURAÇÃO DA EMPRESA | emissor.js | ATIVO |
| Consulta chave | consulta_chave_url_* | A ou B | do cadastro | CONFIGURAÇÃO DA EMPRESA | emissor.js | ATIVO |
| WS Retorno | ws_retorno_* | — | — | contrato | nenhum no emissor (`indSinc=1`) | RESERVADO / NÃO UTILIZADO |
| WS Status | ws_status_* | — | — | contrato / RegistryBuilder | statusServico.js (catálogo SVRS) | RESERVADO (não lê config da empresa) |
| Global sem empresaId | fiscal_ws_* | null | fiscal_ambiente | CONFIGURACAO_GLOBAL | EMPRESA_UNICA / legado | LEGADO |

## Correções

- `getFiscalConfig({ empresaId })` inválido ou sem linha **não** cai no global.
- `resolverUrlsEmissao` recusa mistura ativo ≠ bloco do ambiente.
- Emissor entrega `urlsEmissao.autorizacao` ao transporte (hook `enviarAutorizacao` só para teste).
- DANFE usa `nota.empresa_id` quando existe.
- MUV: `resolverEmissor` encaminha `{ empresaId, db }` (encadeamento; contrato de atendimento intacto).

## Testes

`tests/fiscal/configuracao-fiscal-empresa-real-05-18-3.test.js`

## Sem alteração de regra de emissão

XML, assinatura, SEFAZ, VAS e PDV Universal não foram redesenhados.
