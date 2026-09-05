# MBC-05 — Provider / adaptador bancário e política de secrets

STATUS: implementado. Sem conexão bancária real. Sem Open Finance. Sem OAuth.

## 1. Arquitetura provider

EMPRESA → CONTA → CONFIG_INTEGRACAO_BANCARIA → PROVIDER REGISTRY → IBankProvider → TransacaoBancariaNormalizada → TransacaoBancariaService.

Secrets ficam no SecretStore, fora de `conta_bancaria`, `transacao_bancaria` e `instituicao_financeira`.

## 2. IBankProvider

Contrato único em `contracts/IBankProvider.js` (MBC-01). Métodos: `conectar`, `desconectar`, `listarContas`, `listarTransacoes`, `consultarSaldo`. Sem segundo contrato.

## 3. Registry

`BankProviderRegistry` — registrar, obter, listar, existe. O motor consulta o registry. Sem `if provider ===`.

## 4. Mock

`MockBankProvider`: sem HTTP, sem credencial, DTO determinístico (`external_source = MOCK`, `external_id = MOCK-TRANS-001`). Não grava em `transacao_bancaria`.

## 5. Configuração

Tabela `config_integracao_bancaria`: empresa, conta, provider, ativo, ambiente. Uma ativa por conta (índice parcial). MOCK só em TESTE.

## 6. SecretStore

Interface `ISecretStore` (`set/get/delete/has`). Implementações: `MemorySecretStore` (transição/teste) e `EncryptedLocalSecretStore` (AES-256-GCM). Sem API GET de secrets.

## 7. Política

CONFIGURAÇÃO ≠ SECRET. API devolve `secret_configurado` boolean. Sem token/senha no JSON, logs ou frontend. MOCK não pede secret.

## 8. Criptografia

Mecanismo isolado do MBC. **Não** reutiliza `TEF_ENCRYPTION_KEY`, `LICENSE_MASTER_KEY` nem o `cryptoService` do TEF.

## 9. Chave mestre

Variável de ambiente: `MBC_SECRET_STORE_KEY` (64 hex ou texto derivado via SHA-256).

**Limitação honesta:** o ERP não tem HSM/Vault. Sem `MBC_SECRET_STORE_KEY` o store cifrado **recusa gravar**. Em teste/dev sem chave usa-se memória (`memoria-transicao`). Isso **não** é “secrets seguros em produção”. É abstração pronta para cofre externo (MBC-06+).

## 10. Multiempresa

`BancarioEmpresaContextoService`. Sem empresa 1. Conta de outra empresa: 404.

## 11. APIs

`GET /providers`  
`GET/POST /configuracoes`, `GET/PUT :id`, `PATCH :id/ativar|desativar`  
`POST :id/testar` — só MOCK, **não persiste**. Persistência só via `executarProvider({ persistir: true })` no service/testes.

## 12. UI

Contas Bancárias → Integração. Provider de teste, ambiente TESTE, credencial configurada (sim/não). Sem conectar banco, OAuth ou sincronizar.

## 13. Segurança

Sanitização `sanitizarMbc`. `toJSON` do store redige valores.

## 14. Legado TEF/PIX

**Dívida técnica legada fora do escopo do MBC-05.** Secrets TEF/PIX no SQLite não foram migrados, copiados nem reutilizados.

MBC-05 possui política própria de Secrets; secrets legados de TEF/PIX permanecem fora do escopo.

## 15–21

Ver `IMPLEMENTACAO_MBC_05_RELATORIO.md`.

Recomendação: MBC-06 — Open Finance + Consentimento (ainda sem antecipar OAuth nesta sprint).
