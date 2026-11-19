# DIAGNÓSTICO — Unidade obrigatória no KDS (S07-1)

**Data:** 2026-11-17  
**Escopo:** somente leitura / diagnóstico — **sem implementação**  
**Sintoma observado:** `GET /api/cozinha/preparacao/painel` → **400** `UNIDADE_OBRIGATORIA`  
(`Sessão sem unidade operacional de cozinha.`)

---

## 1. Arquivos e funções examinados

| Camada | Arquivo | Funções / trechos |
|--------|---------|-------------------|
| Auth HTTP | `backend/rotas/auth.js` | `finalizarLoginComUsuario` — lê `unidade_cozinha_id` / `unidadeCozinhaId` / `empresa_id` do body; `validarUnidadeCozinhaNoLogin`; `jwt.sign` com claim `unidade_cozinha_id` |
| Auth unidade | `backend/services/cozinha/cozinhaAuthUnidade.js` | `validarUnidadeCozinhaNoLogin`, `garantirTabelaOperadorUnidades`, `isAdminOperacional` |
| Sessão KDS | `backend/services/cozinha/cozinhaUnidadeOperacional.js` | `unidadeCozinhaDaSessao`, `resolverUnidadeOperacionalReq`, `exigirUnidadeOperacional` |
| Middleware | `backend/middleware/auth.js` | `verificarToken` → `jwt.verify` → `req.user` (claim intacta) |
| Rota painel | `backend/rotas/cozinha.js` | `GET /preparacao/painel` → `resolverUnidadeOperacionalReq(req)` |
| Schema | `backend/utils/cozinhaSchema.js` | DDL `cozinha_unidades` |
| Login UI | `frontend/shared/js/login.js` | `POST /auth/login` com `{ username, password }` apenas |
| Contexto empresa | `frontend/shared/js/cds-empresa-contexto.js` | `X-Empresa-Id` pós-login (independente da unidade) |
| KDS UI | `frontend/erp/js/cozinha-kds.js` | consome painel; não envia `unidade_id` |
| Testes | `tests/cozinha/sprint05-login-unidade-auth.test.js` | login com `unidade_cozinha_id` autorizado/negado |
| Planejamento | `Agent/PLANEJAMENTO-SPRINT07-KDS.md` §4.2 | lacuna já prevista |

---

## 2. Fluxo atual de autenticação

```
UI login.js
  POST /api/auth/login  { username, password }
       │
       ▼
auth.finalizarLoginComUsuario
  unidadeCozinhaIdRaw ← body.unidade_cozinha_id  (hoje: ausente → null)
  empresaIdRaw        ← body.empresa_id          (opcional)
       │
       ▼
validarUnidadeCozinhaNoLogin(...)
  se raw null → retorna null  (login PDV/ERP segue sem unidade)
  se raw presente → valida cadastro + autorização → retorna id
       │
       ▼
jwt.sign({ ..., unidade_cozinha_id: unidadeValidada | null })
localStorage.token / user
       │
       ▼
KDS GET /api/cozinha/preparacao/painel
  verificarToken → req.user
  resolverUnidadeOperacionalReq → unidadeCozinhaDaSessao(req.user)
       │
       └─ sem claim → 400 UNIDADE_OBRIGATORIA
```

**Fato:** o backend **já** embute `unidade_cozinha_id` no JWT quando o body a envia e a validação passa. O frontend **não** a envia.

---

## 3. Origem oficial das unidades

| Fonte | Papel |
|-------|--------|
| **`cozinha_unidades`** | Cadastro oficial de unidades operacionais (`id`, `empresa_id`, `codigo`, `ativo`, `sequencia_atual`) |
| **`cozinha_operador_unidades`** | Vínculo fino operador↔unidade (`empresa_id`, `operador_id`, `unidade_id`, `ativo`) — criada sob demanda no login (`CREATE IF NOT EXISTS`) |
| **`usuario_empresas`** | Autorização do operador na **empresa** da unidade (`UsuarioEmpresaService.usuarioPodeAcessarEmpresa`) |

Relação:

- Unidade **pertence** a uma empresa (`cozinha_unidades.empresa_id`).
- Rodadas/itens/estações referenciam unidade via FKs compostas `(unidade_id, empresa_id)`.
- Não há FK formal `cozinha_unidades → empresas` no DDL atual (apenas coluna `empresa_id`).

---

## 4. Regras de autorização identificadas

Em `validarUnidadeCozinhaNoLogin` (quando `unidade_cozinha_id` é enviado):

1. Unidade deve existir em `cozinha_unidades`.
2. Unidade deve estar `ativo = 1`.
3. Se `empresa_id` veio no login, deve coincidir com `unidade.empresa_id` (`UNIDADE_EMPRESA_ISOLAMENTO`).
4. Operador deve poder acessar a empresa da unidade (`usuario_empresas` / admin).
5. **Admin operacional** (`role=admin` ou perfil `ADMIN`/`SUPER_ADMIN`): qualquer unidade ativa da empresa autorizada.
6. **Demais usuários:** vínculo ativo em `cozinha_operador_unidades` (`UNIDADE_NAO_AUTORIZADA` se ausente).

No painel KDS (após login):

- Fonte autoritativa = **JWT** (`req.user.unidade_cozinha_id`).
- Query/body `unidade_id` **não substitui** a sessão; se informada, deve coincidir (`UNIDADE_ISOLAMENTO` 409).
- Empresa do painel = contexto `X-Empresa-Id` / middleware (separado da unidade).

Códigos relevantes: `UNIDADE_OBRIGATORIA` (400), `UNIDADE_INEXISTENTE` / `UNIDADE_INATIVA` / `UNIDADE_NAO_AUTORIZADA` / `UNIDADE_EMPRESA_ISOLAMENTO` (403), `UNIDADE_ISOLAMENTO` (409).

---

## 5. Respostas às perguntas do briefing

| Pergunta | Resposta |
|----------|----------|
| Usuário pode ter mais de uma unidade? | **Sim.** Modelo `cozinha_operador_unidades` admite N vínculos por operador/empresa. Admin vê todas as ativas da empresa. |
| Unidade antes ou depois da autenticação? | **No login (body)** para entrar no JWT. Não há troca de unidade pós-login no código atual. Pós-login só via **novo login** (ou endpoint futuro de reemissão de token — **não existe**). |
| Fonte oficial das unidades? | Tabela **`cozinha_unidades`**. |
| Como garantir empresa? | No login: opcional `empresa_id` no body vs `unidade.empresa_id`; no painel: middleware de empresa + `exigirUnidadeDaEmpresa` no serviço. |
| Vínculo usuário↔unidade? | **Sim** — `cozinha_operador_unidades` (exceto admin operacional). |
| JWT pode receber o contexto sem enfraquecer auth? | **Sim.** Já implementado: claim só após `validarUnidadeCozinhaNoLogin`. Login sem unidade continua válido para PDV/ERP. |
| Menor alteração no fluxo de login? | Enviar `unidade_cozinha_id` (e idealmente `empresa_id`) no body de `POST /auth/login`, após o operador escolher uma unidade autorizada. |

---

## 6. Lacunas encontradas

1. **`login.js` não coleta nem envia `unidade_cozinha_id`.** Body = `{ username, password }`.
2. **Não existe endpoint HTTP** para listar unidades disponíveis ao usuário autenticado (ou pré-login). Busca em `backend/rotas/cozinha.js`: nenhum `GET .../unidades`.
3. **Não há UI** de seleção/troca de unidade de cozinha no ERP/login.
4. **Empresa no login é opcional** para a claim; o seletor de empresa do ERP (`CdsEmpresaContexto`) é pós-login e **não** preenche unidade no JWT.
5. **Cadastro:** no diagnóstico FK-01 a cópia do oficial tinha **0 linhas** em `cozinha_unidades`. Mesmo com login corrigido, sem unidade cadastrada o login com `unidade_cozinha_id` falha (`UNIDADE_INEXISTENTE`) e o painel permanece inutilizável.
6. Electron `estabelecerSessao({ token })` só propaga o token já emitido — **não** escolhe unidade.

---

## 7. Alternativa técnica recomendada (para autorização futura)

### Opção mínima (alinhada ao backend atual)

1. **Cadastro:** garantir ao menos uma `cozinha_unidades` ativa por empresa operacional (+ vínculos em `cozinha_operador_unidades` para não-admins).
2. **Listagem (novo endpoint autorizado):** ex. `GET /api/cozinha/unidades` (autenticado, filtrado por empresa do contexto + regras admin/vínculo) — **exige autorização TL** (hoje proibido criar endpoint nesta etapa).
3. **Login UI:** campo/seleção de unidade → incluir `unidade_cozinha_id` (+ `empresa_id` da unidade) no `POST /auth/login`.
4. **KDS:** permanece só-leitura; continua usando a claim do JWT (sem mudar contrato S07-0).

### Alternativa (se TL preferir não tocar no formulário de login geral)

- Na abertura do KDS: se JWT sem unidade → modal “selecionar unidade” → **re-login** silencioso/forçado com as mesmas credenciais + `unidade_cozinha_id` (ou endpoint de refresh de token **novo** — maior escopo de segurança).

### Não recomendado

- Aceitar `unidade_id` só na query do painel sem claim no JWT (quebra o contrato S05/S07-0 de origem autenticada).
- Autoatribuir a “primeira unidade” no servidor sem escolha explícita (ambíguo com multiunidade).

---

## 8. Arquivos que precisariam ser alterados (futura implementação)

| Arquivo | Mudança provável |
|---------|------------------|
| `frontend/shared/js/login.js` (+ HTML de login, se houver) | UI + body com `unidade_cozinha_id` / `empresa_id` |
| `backend/rotas/cozinha.js` (+ service) | **Novo** `GET` de unidades autorizadas (se aprovado) |
| Possível seed/admin UI | Cadastro de `cozinha_unidades` / `cozinha_operador_unidades` |
| Testes | Extensão S05 login + S07-1 (sessão com unidade) |

**Provavelmente sem mudança:** `CozinhaKdsPainelService`, contrato S07-0 do painel, Sprint 06, PDV, schema v3.

---

## 9. Riscos e testes necessários (quando autorizar)

| Risco | Mitigação / teste |
|-------|-------------------|
| Operador escolhe unidade de outra empresa | Já coberto: `UNIDADE_EMPRESA_ISOLAMENTO` / `usuarioPodeAcessarEmpresa` |
| Operador sem vínculo fino | Já coberto: `UNIDADE_NAO_AUTORIZADA` (S05) |
| Login PDV sem unidade continua quebrando | Manter unidade **opcional** no login (comportamento atual) |
| Token antigo sem claim após deploy | Exigir re-login; KDS já mostra `UNIDADE_OBRIGATORIA` |
| Lista de unidades vazia no oficial | Pré-requisito operacional: cadastrar unidade antes da homologação visual |
| Endpoint de listagem vazar unidades de outra empresa | Filtrar por empresa do contexto + mesmas regras do login |

Testes sugeridos (futuros): regressão `sprint05-login-unidade-auth`; login UI com/sem unidade; KDS 200 com claim; KDS 400 sem claim; operador multiunidade isolado.

---

## 10. Conclusão

O KDS falha com **400 `UNIDADE_OBRIGATORIA`** porque o JWT da sessão web **não contém** `unidade_cozinha_id`. O backend de login **já** sabe emitir essa claim com validação segura; a lacuna é **frontend de login + ausência de API/UI de listagem + possível cadastro vazio de unidades**.

**Parar. Aguardar autorização do Tech Lead para qualquer implementação.**
