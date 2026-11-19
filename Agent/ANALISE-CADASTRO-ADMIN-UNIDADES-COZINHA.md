# ANÁLISE — Cadastro administrativo de unidades de cozinha

**Data:** 2026-11-17  
**Projeto:** CDS Pastelaria  
**Status:** SOMENTE ANÁLISE — **nenhuma alteração executada**  
**Escopo:** inventário de UI/API + proposta; sem insert oficial; sem S07-3

---

## 1. Existe tela de cadastro? Em qual menu?

**Não existe.**

| Evidência | Detalhe |
|-----------|---------|
| Menu ERP | Em `frontend/erp/index.html`, a única entrada de Cozinha é **Comercial → Cozinha (KDS)** (`data-page="cozinha-kds"`). |
| Scripts | `frontend/erp/js/app.js` registra apenas `'cozinha-kds': ['/erp/js/cozinha-kds.js']`. |
| Arquivos frontend Cozinha | Somente `frontend/erp/js/cozinha-kds.js` e `frontend/css/cozinha-kds.css` (painel/seleção S07-1/S07-2). |
| Busca `cozinha_unidades` / formulário no `frontend/` | **0 ocorrências** de cadastro. |

A tela KDS **consome** unidades (`GET /unidades-disponiveis`); **não cadastra**.

---

## 2. Permite cadastrar código, nome, empresa e situação ativa?

**Não** — não há formulário.

### Modelo persistido hoje (`cozinha_unidades`)

Definido em `backend/utils/cozinhaSchema.js`:

| Campo | Existe? | Uso |
|-------|---------|-----|
| `empresa_id` | Sim | Isolamento por empresa |
| `codigo` | Sim | Identificador operacional (único por empresa) |
| `ativo` | Sim | Situação ativa/inativa |
| `sequencia_atual` | Sim | Sequência de despacho |
| **`nome`** | **Não** | Coluna inexistente no schema v3 |

O KDS exibe rótulo a partir de `codigo` (`Unidade {codigo}`). Qualquer “nome” exigiria migration futura (fora desta análise / sem executar).

---

## 3. Existe tela para vincular operadores em `cozinha_operador_unidades`?

**Não.**

| Evidência | Detalhe |
|-----------|---------|
| Tabela | Criada sob demanda em `cozinhaAuthUnidade.garantirTabelaOperadorUnidades` (`CREATE IF NOT EXISTS`). |
| UI | Nenhuma página ERP para vínculos. |
| API | Nenhum endpoint de CRUD de vínculos; apenas uso em listagem/validação S07-2. |
| Dados oficiais (diagnóstico anterior) | Tabela vazia (0 vínculos). |

---

## 4. O que já existe (relacionado, mas não é cadastro)

| Componente | Arquivo | Função |
|------------|---------|--------|
| Listagem autorizada (KDS) | `backend/rotas/cozinha.js` → `GET /unidades-disponiveis` | Só leitura para seleção |
| Seleção + JWT | `POST /sessao/unidade` + `CozinhaSessaoUnidadeService.js` | Contexto de sessão |
| Autorização | `cozinhaAuthUnidade.js` | Admin vê ativas da empresa; operador só com vínculo |
| Sessão operacional | `cozinhaUnidadeOperacional.js` | Claim JWT nas operações |
| Painel | `GET /preparacao/painel` + `cozinha-kds.js` | Consulta pós-contexto |

**Não alterar** essas regras na proposta de cadastro (preservar S07-2).

---

## 5. Arquivos envolvidos (inventário)

### Existentes (somente leitura / consumo)
- `frontend/erp/index.html` — menu KDS
- `frontend/erp/js/app.js` — lazy load KDS
- `frontend/erp/js/cozinha-kds.js` — seleção/painel
- `frontend/css/cozinha-kds.css`
- `frontend/shared/js/access-control.js` — ACL `cozinha-kds`
- `frontend/shared/js/cds-empresa-contexto.js` — `X-Empresa-Id`
- `backend/rotas/cozinha.js`
- `backend/services/cozinha/CozinhaSessaoUnidadeService.js`
- `backend/services/cozinha/cozinhaAuthUnidade.js`
- `backend/services/cozinha/cozinhaUnidadeOperacional.js`
- `backend/utils/cozinhaSchema.js` — DDL `cozinha_unidades` / meta
- `tests/cozinha/sprint07-s07-2-sessao-unidade-kds.test.js`

### Inexistentes (a criar, se autorizado — **não executar agora**)
- `frontend/erp/js/cozinha-unidades.js` (gestão)
- `frontend/erp/js/cozinha-operador-unidades.js` (vínculos) — ou seção na mesma página
- Endpoints `POST/GET/PATCH /api/cozinha/unidades` e vínculos
- Serviço `CozinhaUnidadeCadastroService.js` (nome sugerido)

---

## 6. Proposta de implementação (não executar)

### 6.1 Objetivos
1. Cadastro/edição de unidades em `cozinha_unidades` integrado ao ERP.  
2. Vínculo operador↔unidade em `cozinha_operador_unidades`.  
3. Isolamento por empresa do contexto autenticado.  
4. Somente admin operacional (`role=admin` ou perfil `ADMIN`/`SUPER_ADMIN`) — alinhado a `isAdminOperacional`.  
5. Zero impacto nas regras S07-2 de seleção/JWT.

### 6.2 Backend (mínimo)

**Unidades**
- `GET /api/cozinha/unidades` — listar da empresa do contexto (ativas e inativas para gestão).
- `POST /api/cozinha/unidades` — body `{ codigo, ativo? }`; `empresa_id` **só** do contexto; validar unicidade `(empresa_id, codigo)`.
- `PATCH /api/cozinha/unidades/:id` — atualizar `codigo`/`ativo` na mesma empresa; rejeitar id de outra empresa.

**Vínculos**
- `GET /api/cozinha/unidades/:id/operadores`
- `PUT /api/cozinha/operador-unidades` — body `{ operador_id, unidade_id, ativo }` com checagem empresa+unidade+usuário.

Middleware: `verificarToken` + contexto empresa + `isAdminOperacional` (ou `exigirAdmin`).  
**Não** aceitar `empresa_id` do body como autoridade.

### 6.3 Frontend ERP
- Menu **Comercial** (junto ao KDS): **Unidades de Cozinha** (`data-page="cozinha-unidades"`).
- Lista + formulário: código, ativo (checkbox); empresa = rótulo do contexto (somente leitura).
- Sem campo nome até existir coluna (opcional futuro / migration separada com autorização).
- Aba ou seção: vincular operadores da empresa à unidade selecionada.
- ACL: mesmo gate admin / recurso `pedidos` + verificação de perfil no backend.

### 6.4 Fora do escopo da proposta
- Auto-criação na abertura do KDS  
- Insert direto no oficial por script de homologação sem PO/TL  
- Alterar JWT, login, PDV, Sprint 06, schema `nome` sem migration autorizada  
- S07-3  

### 6.5 Ordem sugerida de entrega (quando autorizado)
1. API unidades (CRUD mínimo) + testes isolados  
2. Tela ERP unidades  
3. API + UI vínculos  
4. Homologação: cadastrar `COZ-01` → KDS lista → seleciona → painel  

---

## 7. Respostas diretas

| # | Pergunta | Resposta |
|---|----------|----------|
| 1 | Existe tela? Menu? | **Não.** Só KDS em Comercial. |
| 2 | Código, nome, empresa, ativo? | **Não há cadastro.** Schema tem código/empresa/ativo; **não tem nome**. |
| 3 | Tela de vínculos? | **Não.** |
| 4 | Proposta? | Sim — §6 (aguardando autorização para implementar). |

---

**Não iniciado S07-3. Não executada implementação. Não inseridos dados oficiais.**  
Aguardando decisão do Product Owner / Tech Lead para autorizar a implementação do cadastro administrativo.
