# Fase 2 / Implementação 03.1
## Cadastro oficial de empresas

**Data:** 2026-08-14 · **Status:** implementada  
**Escopo:** entidade EMPRESA + CNPJ único + contexto reconhece a tabela  
**Fora de escopo:** `estoque_empresa`, JWT, seletor, vínculo usuário, migração de saldo, alteração de motores, remoção de COMPAT

---

## 1. Auditoria prévia

Não existia `CREATE TABLE empresas` no backend.

O que já existia (não duplicado):

| Item | Papel |
|---|---|
| `empresaContexto.js` | contrato `empresaId` + `SELECT` opcional se a tabela existir |
| `dfe_auditoria.empresa_id` | log DistDFe, não cadastro |
| `configuracoes.cnpj` | emitente fiscal; **não** usado como fallback |
| `empresa_cnpj` em caixa/entrega | exibição; não é a entidade |

Não foi necessário parar: não havia estrutura equivalente de cadastro.

---

## 2. Modelo

Tabela `empresas`:

| Campo | Tipo | Regra |
|---|---|---|
| `id` | INTEGER PK | `empresaId` oficial |
| `cnpj` | TEXT NOT NULL | único, 14 dígitos normalizados |
| `razao_social` | TEXT NOT NULL | obrigatória |
| `nome_fantasia` | TEXT | opcional |
| `inscricao_estadual` | TEXT | opcional |
| `inscricao_municipal` | TEXT | opcional |
| `ativo` | INTEGER NOT NULL DEFAULT 1 | 1 = ativa, 0 = inativa (sem delete físico) |
| `created_at` | DATETIME | |
| `updated_at` | DATETIME | |

Índice: `UNIQUE idx_empresas_cnpj (cnpj)`.

Não há seed de “empresa 1” / default.

Produto permanece **global**. Estoque permanece em `produtos`. Não existe `estoque_empresa` nem `produto_empresa`.

---

## 3. CNPJ

- Obrigatório no cadastro.
- Normalização: `12.345.678/0001-90` → `12345678000190`.
- Validação: 14 dígitos + dígitos verificadores; rejeita sequência repetida.
- Unicidade na tabela.
- `buscarEmpresaPorCnpj` faz o fluxo CNPJ → normalização → `empresas` → `empresaId`.
- NF-e / compras / vendas **não** passaram a resolver CNPJ automaticamente.

Implementação: `backend/services/empresas/empresaCnpj.js` (independente do MIIP).

---

## 4. EmpresaId e contexto

`empresaContexto.validarEmpresaId` / `resolverContextoEmpresa`:

- Se a tabela `empresas` existir e o id não estiver nela → `EMPRESA_NAO_ENCONTRADA`.
- Se a linha existir e `ativo = 0` → `EMPRESA_INATIVA` (não serve como contexto operacional novo).
- Schema antigo de testes sem coluna `ativo` continua aceito (trata como ativa).
- Sem `empresaId` + `COMPAT_*` explícita → legado, como antes.
- Empresa **não** ficou obrigatória globalmente.

---

## 5. Serviço

`backend/services/empresas/EmpresaService.js`

- `criarEmpresa`
- `listarEmpresas`
- `buscarEmpresaPorId`
- `buscarEmpresaPorCnpj`
- `atualizarEmpresa`
- `ativarEmpresa`
- `inativarEmpresa`

Não altera produtos, saldos, reservas, compras ou vendas.

---

## 6. APIs

Montadas em `/api/empresas` com `verificarToken` existente (sem JWT novo).

| Método | Rota |
|---|---|
| GET | `/api/empresas` (`?ativo=1\|0` opcional) |
| GET | `/api/empresas/:id` |
| POST | `/api/empresas` |
| PUT | `/api/empresas/:id` |
| PATCH | `/api/empresas/:id/ativar` |
| PATCH | `/api/empresas/:id/inativar` |

Erros: `{ error, code }` com HTTP 400 / 404 / 409.

| Código | Quando |
|---|---|
| `CNPJ_EMPRESA_OBRIGATORIO` | CNPJ ausente |
| `CNPJ_EMPRESA_INVALIDO` | formato/DV inválido |
| `CNPJ_EMPRESA_DUPLICADO` | CNPJ já cadastrado |
| `RAZAO_SOCIAL_OBRIGATORIA` | razão social ausente |
| `EMPRESA_NAO_ENCONTRADA` | id/CNPJ inexistente |
| `EMPRESA_INATIVA` | contexto operacional com empresa inativa |
| `EMPRESA_JA_ATIVA` | ativar já ativa |
| `EMPRESA_JA_INATIVA` | inativar já inativa |

---

## 7. Limitações (conscientes)

- Sem JWT / `usuario.empresa_id` / seletor.
- Sem isolamento de estoque (`empresaId` ≠ saldo separado).
- COMPAT das Sprints 02.x permanece.
- CNPJ de `configuracoes` não alimenta esta tabela.
- Próxima sprint prevista: 03.2 contexto + seletor.
