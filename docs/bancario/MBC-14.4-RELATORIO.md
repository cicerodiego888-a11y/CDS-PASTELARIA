# IMPLEMENTAÇÃO MBC-14.4

SPRINT: MBC-14.4

STATUS: CONCLUÍDA

Classificação: **CONFIGURAÇÃO SEGURA DE CREDENCIAIS IMPLEMENTADA**

Não declarar Mercado Pago “conectado”. Estado correto: **CREDENCIAIS CONFIGURADAS / INFRAESTRUTURA PREPARADA**.

## Modelo final

```
EMPRESA → CONTA_BANCARIA → CONFIG_INTEGRACAO_BANCARIA → ISecretStore → PROVIDER
```

- Client ID / Application ID → `config_integracao_bancaria.aplicacao_ref` (dado público).
- Client Secret → ISecretStore, chave existente `mbc.config.{configId}` (MBC-05).
- Sem coluna nova, sem tabela paralela, sem `MERCADO_PAGO_CLIENT_SECRET` em config-servidor.json.

## Arquivos alterados

- `backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService.js`
- `backend/motores/bancario/MotorBancarioService.js`
- `backend/motores/bancario/contracts/constantes.js`
- `backend/motores/bancario/version.js`
- `backend/motores/bancario/secrets/EncryptedLocalSecretStore.js`
- `backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider.js`
- `backend/rotas/bancario.js`
- `frontend/erp/pages/contas-bancarias.html`
- `frontend/erp/js/contas-bancarias.js`
- `tests/bancario/motor-bancario-14-4.test.js`
- `tests/bancario/motor-bancario-14-3.test.js` (SPRINT startsWith MBC-14)

## Novas rotas

- `GET /api/bancario/configuracoes/:id/credenciais`
- `POST /api/bancario/configuracoes/:id/credenciais`
- `DELETE /api/bancario/configuracoes/:id/credenciais`

GET/POST/DELETE nunca devolvem Client Secret.

## Novos métodos

- `configurarCredenciaisMercadoPago`
- `obterStatusCredenciais`
- `removerCredenciaisMercadoPago`
- `obterCredenciaisProvider` (interno; não exposto na API)

## SecretStore

ISecretStore / MemorySecretStore / EncryptedLocalSecretStore (MBC-05). Sem segundo cofre.

## Limitações

- OAuth real, troca de code, sincronização e chamada ao Mercado Pago **não** foram implementados.
- PKCE S256, Redirect URI, gateway 3010 e ERP 3001 intactos.
- Provider OPEN_FINANCE_REAL permanece bloqueado para operação real.

## Segurança

Client Secret não vai para SQLite da config, JSON de GET, frontend após salvar, URL, logs do serviço nem `toJSON` do store. `empresa_id` no body não altera ownership. Isolamento A/B.

## Testes

- MBC-14.4: 19/19
- MBC-01 a MBC-14.4: 646/646
- Financeiro 05.38.D 20/20 · 05.41 14/14
- Caixa 05.38.C 17/17
- Vendas 05.40 13/13
- Compras 05.64 OK

## Pendências

Nenhuma desta sprint. OAuth real e operação Mercado Pago permanecem fora de escopo.
