# MBC-14.4.2 — Persistência do Client Secret (Mercado Pago)

## 1. STATUS

**CORREÇÃO CONCLUÍDA**

## 2. CAUSA RAIZ

1. `MBC_SECRET_STORE_KEY` ausente no processo do ERP.
2. `obterSecretStore()` fazia fallback silencioso para `MemorySecretStore`.
3. `server.js` / rotas criavam motor bancário por request.
4. Cada request recebia um `MemorySecretStore` novo.
5. POST gravava o secret só na memória da request; GET seguinte via store vazio → `secret_configurado = false`.
6. Client ID em `aplicacao_ref` (SQLite) continuava correto — sintoma assimétrico.

## 3. CORREÇÃO

**Fail closed:**

- `obterSecretStore` **não** cria mais `MemorySecretStore` como fallback.
- Sem `db` → erro `MBC_SECRET_KEY_AUSENTE` (HTTP 503) com mensagem funcional.
- Com `db` → sempre `EncryptedLocalSecretStore`.
- Sem `MBC_SECRET_STORE_KEY` → `set`/`get` recusam com o mesmo erro (sem falso sucesso).
- `MemorySecretStore` permanece **somente** por injeção explícita em testes.
- `MotorBancarioService`: resolução lazy do SecretStore (evita exigir cofre em operações que não usam secret).

**Operação:**

Definir no processo do ERP (nunca no repositório):

```text
MBC_SECRET_STORE_KEY=<chave forte local, 64 hex ou texto>
```

Sem valor real neste documento.

## 4. ARQUIVOS ALTERADOS

| Arquivo | Mudança |
|---------|---------|
| `backend/motores/bancario/secrets/EncryptedLocalSecretStore.js` | Fail closed; mensagem 503 funcional |
| `backend/motores/bancario/MotorBancarioService.js` | Lazy `secretStore` (necessário para propagar erro só quando o cofre é usado) |
| `tests/bancario/motor-bancario-14-4-2.test.js` | Novos testes A→B e sem chave |
| `tests/bancario/motor-bancario-09.test.js` | T17 alinhado ao fail closed |
| `docs/bancario/MBC-14.4.2-RELATORIO.md` | Este relatório |

Não alterados: frontend, OAuth/MBC-15, payload, providers, schema/tabelas.

## 5. COMPORTAMENTO COM CHAVE

1. POST credenciais → Client ID em `aplicacao_ref`; Client Secret só em `mbc_secret_store`.
2. `secret_configurado = true`.
3. Novo motor (nova instância do store) + mesmo `db` → `secret_configurado` permanece `true`.

## 6. COMPORTAMENTO SEM CHAVE

1. Tentativa de gravar Client Secret → rejeitada (`SECRET_KEY_AUSENTE` / 503).
2. Mensagem: *Armazenamento seguro de credenciais bancárias indisponível.*
3. Nenhum `secret_configurado=true` baseado em memória.
4. Nenhum secret na tabela de configuração.

## 7. TESTE DE REQUEST A → REQUEST B

Coberto por `motor-bancario-14-4-2.test.js` T03:

- Motor A salva com `EncryptedLocalSecretStore`.
- Motor B novo, **sem** compartilhar a instância do store.
- `secret_configurado = true` em ambos.

## 8. TESTES EXECUTADOS

| Suite | Resultado |
|-------|-----------|
| `motor-bancario-14-4-2.test.js` | **6/6 pass** |
| MBC-05 / MBC-09 (SecretStore) | **pass** (T17 fail closed) |
| MBC-14.4 | **pass** |
| MBC-15 | **pass** |

## 9. SEGURANÇA

- GET credenciais não expõe `client_secret`.
- Secret não vai para `aplicacao_ref` / JSON público / `toJSON()`.
- Ciphertext em `mbc_secret_store` sem plaintext.
- Chave mestre só em variável de ambiente do processo.

## 10. MULTIEMPRESA

Inalterado. Chave do store: `mbc.config.{configId}`. Conta/config continuam no contexto da empresa. Frontend não é autoridade de `empresa_id`.

## 11. REGRESSÃO MBC-01..MBC-15

| Faixa | Resultado |
|-------|-----------|
| MBC-01 … MBC-08 | **258/258 pass** |
| MBC-09 … MBC-15 (+ 14.1–14.4.2) | **410/410 pass** |
| **Total regressão solicitada** | **668/668 pass · 0 falhas** |

## 12. RISCOS/PENDÊNCIAS

- Operadores **devem** definir `MBC_SECRET_STORE_KEY` no ambiente do ERP antes de configurar credenciais reais.
- Segredos que existiram só em `MemorySecretStore` por request **não** são recuperáveis (não há migration).
- Não há `.env.example` no repositório; a obrigatoriedade da variável está documentada aqui.
- Em ERP local, `server.js` / `electron.js` podem gerar/ler `mbc-secret-store.key` em `DB_DIR` se a variável não estiver definida (valor nunca logado).
- OAuth/MBC-15 e tokens continuam no mesmo SecretStore — passam a depender da mesma chave para persistência real.
- UI: campo Client Secret exibe máscara `••••••••` quando `secret_configurado` (não é o secret real).
