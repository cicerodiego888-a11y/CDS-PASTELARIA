# AUDITORIA — URLs fiscais do Motor Fiscal (Sprint 05.18.2)

Não inventa endpoint. Não cria motor novo.

## Resumo

Há **duas origens** de URL no CDS:

1. **Contrato de configuração** (`getFiscalConfig` / `empresas_configuracao_fiscal` / tabela `configuracoes`)
2. **Catálogo da Plataforma Fiscal** (`RegistryBuilder.ENDPOINTS`) — URLs oficiais SVRS/AN no código, sem coluna por empresa

O override de banco no `UrlResolver` **ainda não está ligado**.

## 1. URLs do contrato (configuráveis)

Usadas na emissão NFC-e (`emissor.js`) via `config.urls` após `getFiscalConfig({ empresaId })`.

| Operação | Serviço | Config | Homologação | Produção |
|---|---|---|---|---|
| Autorização NFC-e (fallback / `enviarAutorizacao.url`) | `emissor.js` → `autorizacaoRuntime` (`input.url`) | `ws_autorizacao_*` / `fiscal_ws_autorizacao_*` | sim | sim |
| QRCode NFC-e | `emissor.js` + `qrcode.js` | `csc_qrcode_url_*` / `fiscal_csc_qrcode_url_*` | sim | sim |
| Consulta chave (URL pública no QR/XML) | `emissor.js` | `consulta_chave_url_*` / `fiscal_consulta_chave_url_*` | sim | sim |
| WS Retorno | persistido; **não lido** pelo `emissor.js` hoje | `ws_retorno_*` / `fiscal_ws_retorno_*` | sim | sim |
| WS Status | persistido; **não lido** pelo `emissor.js` hoje | `ws_status_*` / `fiscal_ws_status_*` | sim | sim |

Seleção: ambiente `1` → bloco produção; `2` → bloco homologação.

**Global (Plataforma Fiscal / `fiscal.js`):** 10 chaves `fiscal_*_homologacao` e `fiscal_*_producao`.

**Por empresa (antes desta sprint):** 5 colunas únicas (`ws_autorizacao`, `ws_retorno`, `ws_status`, `csc_qrcode_url`, `consulta_chave_url`) — o mesmo valor para os dois ambientes.

**Por empresa (05.18.2):** as 10 colunas `*_homologacao` / `*_producao`, com fallback de leitura para as 5 colunas legadas.

## 2. URLs do catálogo (não são campos da tela Empresas)

`backend/services/fiscal/core/RegistryBuilder.js` — CE/SVRS + Ambiente Nacional.

| Operação | Runtime | Origem | Homologação | Produção | Persistido por empresa? |
|---|---|---|---|---|---|
| Autorização NFC-e (plataforma) | `autorizacaoRuntime` | `ENDPOINTS.NFCE_AUTORIZACAO` | sim | sim | não |
| Retorno autorização NFC-e | registry; runtime reservado (`indSinc=1`) | `NFCE_RETORNO` | sim | sim | não |
| Status serviço NFC-e | transport enablement | `NFCE_STATUS` | sim | sim | não |
| Consulta protocolo NFC-e / NF-e | `consultaProtocoloLegado` + registry | `NFCE_CONSULTA` / `NFE_CONSULTA` | sim | sim | não |
| Cancelamento / evento NFC-e | `cancelarNfce` / `cancelamentoLegado` | `NFCE_EVENTO` (legado usa registry/hardcode) | sim | sim | não |
| Autorização NF-e | `nfeEmissorVenda.js` hardcode SVRS | `NFE_AUTORIZACAO` | sim | sim | não |
| Evento NF-e | `cancelarNfe` | `NFE_EVENTO` | sim | sim | não |
| Distribuição DF-e | `distribuicaoDFe` / runtime | `DFE` (AN) | sim | sim | não |
| Manifestação | `manifestacaoLegado` + registry | `AN_RECEPCAO_EVENTO` | sim | sim | não |

## 3. Operações sem URL no contrato e sem catálogo completo

| Operação | Situação |
|---|---|
| Inutilização | Enum `OperationType.INUTILIZACAO` + timeout. **Sem endpoint no RegistryBuilder. Sem runtime. Sem chave de config.** |
| Consulta cadastro | **Não existe** no motor (sem arquivo, sem registry, sem `configuracoes`). |

**Não criar campos** para inutilização, cadastro, cancelamento, DF-e ou manifestação na tela Empresas — não há coluna nem leitura no contrato fiscal da empresa.

## 4. Tela Empresas — o que já existia vs o que faltava

Já existia na Plataforma Fiscal global (não na gestão por empresa):

- QR / chave / WS autorização / retorno / status × homologação e produção

Na tela Empresas (antes): um único input `ws_autorizacao`.

Faltava na tela Empresas: os 10 campos do contrato (homologação + produção), isolados por `empresa_id`.

## 5. Central de Entradas / DF-e

DF-e usa o catálogo AN, não a configuração da empresa. Sem alteração nesta sprint.
