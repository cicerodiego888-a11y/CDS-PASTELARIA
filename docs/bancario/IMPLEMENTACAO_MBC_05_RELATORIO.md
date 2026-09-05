# IMPLEMENTAÇÃO MBC-05

STATUS: CONCLUÍDA COM RESSALVA DE CHAVE MESTRE

## Arquitetura

Registry + IBankProvider + MOCK + SecretStore isolado. Persistência de transações continua no MBC-03.

## Provider / Registry / Mock

Somente MOCK operacional. Sem HTTP. DTO `TransacaoBancariaNormalizada`.

## Configuração

`config_integracao_bancaria` por conta. Uma ativa. MOCK + PRODUCAO rejeitado.

## Secrets

ISecretStore. Sem secrets nas tabelas funcionais. Sem GET `/secrets`. Sem secret no frontend.

## Criptografia / chave

`MBC_SECRET_STORE_KEY`. Sem chave: recusa persistência cifrada; memória só como transição. **Não declarar secrets “seguros”.** Sem Vault/HSM.

## Multiempresa / APIs / UI

Contexto oficial. APIs de config e providers. UI “Provider de teste”. `POST .../testar` não persiste.

## Legado TEF/PIX

Fora do escopo. Não migrado.

## Não implementado

Open Finance, OAuth, OFX, APIs reais, sync real, conciliação automática, alteração financeiro/vendas/compras/caixa/PIX/TEF/MIS/MUC/PDV.

## Testes / regressão

MBC-05 30/30. MBC-01 11/11. MBC-02 22/22. MBC-03 31/31. MBC-04 33/33.
Financeiro 05.38.D / 05.41, Caixa 05.38.C, Vendas 05.40, Compras 05.64.

## Arquivos

- `contracts/IBankProvider.js`, `constantes.js`, `sanitizarMbc.js`
- `providers/MockBankProvider.js`, `BankProviderRegistry.js`
- `secrets/ISecretStore.js`, `MemorySecretStore.js`, `EncryptedLocalSecretStore.js`
- `services/ConfiguracaoIntegracaoBancariaService.js`
- `schema/bancarioSchema.js`, `MotorBancarioService.js`, `index.js`, `version.js`
- `rotas/bancario.js`
- UI contas bancárias
- `tests/bancario/motor-bancario-05.test.js`
- docs MBC-05

## Riscos / pendências

Chave mestre só via env. Homologação visual. Provider real na MBC-06.

## Recomendação

MBC-06 — Open Finance + Consentimento.
