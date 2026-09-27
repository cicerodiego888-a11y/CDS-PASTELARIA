# MBC-ITAU-01 — RELATÓRIO

STATUS: **CONCLUÍDO COM RESSALVAS**

## 1. ARQUITETURA

| Item | Valor |
|------|--------|
| IBankProvider utilizado | `backend/motores/bancario/contracts/IBankProvider.js` (sem nova interface) |
| Factory/Registry | `BankProviderRegistry.criarRegistryPadrao()` |
| Provider Mercado Pago | Continua em `OPEN_FINANCE_REAL` + serviços/clients Mercado Pago (inalterados funcionalmente) |
| Provider Itaú | `ITAU` → `ItauBankProvider` |

Mapa reutilizado:

```
INSTITUIÇÃO → CONTA BANCÁRIA → CONFIGURAÇÃO DE INTEGRAÇÃO
    → PROVIDER (registry) → IBankProvider → MOTOR → TRANSAÇÕES / SALDO / CONCILIAÇÃO
```

Não foi criado segundo motor, segunda tabela de conta ou Secret Store paralelo.

## 2. CONTA ITAÚ

- Conta alvo (produção): Itaú · Agência 7751 · Conta ••••2762-8 · PASTELARIA DO CHEFF — FILIAL 2 · CNPJ 38.204.469/0003-87
- A sprint **não cria** conta nova no banco oficial; a UI escolhe provider `ITAU` automaticamente quando a instituição contém “Itaú” e vincula `config_integracao_bancaria` à conta existente.
- Testes usam conta espelho (agência 7751 / número 27628) em SQLite `:memory:`.

## 3. CREDENCIAIS

| Item | Detalhe |
|------|---------|
| Mecanismo | `EncryptedLocalSecretStore` / `MemorySecretStore` (testes) |
| Client ID | `aplicacao_ref` (público) |
| Client Secret | `mbc.config.{configId}` |
| Certificado | `mbc.itau.cert.{configId}` |
| Private key | `mbc.itau.key.{configId}` |

Frontend recebe apenas flags booleanas (`*_configurado`). PEM/secret nunca retornam após salvar.

## 4. FRONTEND

- Provider selecionável: Mercado Pago (`OPEN_FINANCE_REAL`) e Itaú (`ITAU`)
- Painéis distintos: `#mbcCredPanelMp` / `#mbcCredPanelItau`
- Campos Itaú: Client ID, Client Secret, Certificado PEM, Private key PEM
- Mercado Pago: Application ID / Client Secret + OAuth preservados
- Botão **Testar conexão** (somente Itaú)

## 5. AUTENTICAÇÃO

| Ambiente | Comportamento |
|----------|----------------|
| Sandbox / Homologação | OAuth Client Credentials; mTLS **não** exigido |
| Produção | OAuth Client Credentials + **mTLS obrigatório** (cert + key) |
| Token | Cache em memória (~300s, margem 30s); nunca logado |
| Endpoints | Centralizados em `ITAU_ENDPOINTS` / `endpointsParaAmbiente` (override via env) |
| Teste de conexão | `POST /api/bancario/configuracoes/:id/conexao/testar` |

## 6. TESTES

| Suíte | Resultado |
|-------|-----------|
| `motor-bancario-itau-01.test.js` | 9/9 OK |
| Regressão MP + Itaú (09, 14-4*, 15*, 16*, itau-01) | **180/180 OK** |
| `ITAU_REAL` / `ITAU_OFICIAL` | Continuam desconhecidos (compatível com T09/T10 antigos) |

## 7. ARQUIVOS ALTERADOS / CRIADOS

**Criados**
- `backend/motores/bancario/providers/itau/ItauConstants.js`
- `backend/motores/bancario/providers/itau/ItauOAuthClient.js`
- `backend/motores/bancario/providers/itau/ItauBankProvider.js`
- `backend/motores/bancario/services/ItauCredenciaisService.js`
- `tests/bancario/motor-bancario-itau-01.test.js`
- `docs/bancario/MBC-ITAU-01-RELATORIO.md`

**Alterados**
- `backend/motores/bancario/contracts/constantes.js` (`CODIGO_PROVIDER.ITAU`)
- `backend/motores/bancario/providers/BankProviderRegistry.js`
- `backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService.js`
- `backend/motores/bancario/MotorBancarioService.js`
- `backend/rotas/bancario.js`
- `backend/motores/bancario/contracts/sanitizarMbc.js`
- `backend/motores/bancario/version.js` (`SPRINT: MBC-ITAU-01`)
- `frontend/erp/pages/contas-bancarias.html`
- `frontend/erp/js/contas-bancarias.js`

## 8. BLOQUEIOS EXTERNOS

Para autenticação/saldo/extrato **reais** ainda falta (conforme portal Itaú):

- [ ] Cadastro / app no portal developer Itaú
- [ ] Produto Extrato (Account Statement) contratado/habilitado
- [ ] Client ID / Client Secret reais
- [ ] Certificado + private key (produção / mTLS)
- [ ] Confirmação das URLs oficiais sandbox vs produção no ambiente do cliente
- [ ] Homologação Itaú

## 9. PRÓXIMO PASSO

Enquanto credenciais/certificado reais não estiverem disponíveis:

**MBC-ITAU-01.1 — PREPARAÇÃO DAS CREDENCIAIS ITAÚ**

Quando autenticação real estiver ok:

**MBC-ITAU-02 — PRIMEIRA CHAMADA ITAÚ — SALDO REAL + EXTRATO REAL**

## Ressalvas

1. Saldo/extrato Itaú **não** implementados (501 / fora de escopo) — de propósito.
2. Mercado Pago permanece sob código `OPEN_FINANCE_REAL` (não renomeado nesta sprint para não quebrar OAuth/sync).
3. Núcleo ainda contém métodos `*MercadoPago*` (compatibilidade); despacho de credenciais na rota passou a ser por provider (`configurarCredenciaisProvider`).
4. URLs Itaú em `ITAU_ENDPOINTS` são pontos de configuração — validar no portal oficial antes de produção.
