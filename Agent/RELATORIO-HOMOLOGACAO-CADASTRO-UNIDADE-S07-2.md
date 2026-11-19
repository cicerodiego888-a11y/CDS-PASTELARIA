# RELATÓRIO — Homologação hotfix S07-2: cadastro de unidade

**Data:** 2026-11-17  
**Status:** DIAGNÓSTICO + PROPOSTA (cadastro oficial **não** executado)  
**Restrições respeitadas:** sem insert no oficial; sem auto-criação; sem alteração JWT/isolamento S07-2; sem S07-3

---

## 1. Existe tela administrativa de cadastro?

**Não.**

### Evidências

| Camada | Busca | Resultado |
|--------|-------|-----------|
| Menu ERP | `frontend/erp/index.html` | Apenas `data-page="cozinha-kds"` (painel). Sem item de cadastro de unidades. |
| Scripts ERP | `frontend/erp/js/app.js` | Só `'cozinha-kds': ['/erp/js/cozinha-kds.js']`. |
| Frontend | grep `cozinha_unidades` / formulário de unidade | Somente consumo KDS (`cozinha-kds.js`). |
| Rotas | `backend/rotas/cozinha.js` | `GET /unidades-disponiveis`, `POST /sessao/unidade`, painel/preparação/impressão. **Sem** `POST/PUT` de cadastro de unidade. |
| Serviços | `backend/services/cozinha/*` | Sem serviço de CRUD de `cozinha_unidades`. |
| Planejamento | `Agent/PLANEJAMENTO-SPRINT07-KDS.md` | Seleção pós-login; cadastro tratado como pré-requisito operacional, não como tela entregue. |

Conclusão: **não há funcionalidade de cadastro** que grave em `cozinha_unidades` pela aplicação.

---

## 2. A tela grava em `cozinha_unidades`?

**N/A** — inexistente.  
Gravações atuais em `cozinha_unidades` ocorrem apenas em **testes** (`INSERT` nos suites) e na criação de schema (`CREATE TABLE`), não via UI/API de gestão.

---

## 3. Modelo atual da tabela (schema v3)

Campos em `backend/utils/cozinhaSchema.js`:

| Campo | Tipo | Observação |
|-------|------|------------|
| `id` | INTEGER PK | Auto |
| `empresa_id` | INTEGER NOT NULL | Empresa dona da unidade |
| `codigo` | TEXT NOT NULL | Identificador operacional (único por empresa) |
| `ativo` | INTEGER DEFAULT 1 | Situação ativa/inativa |
| `sequencia_atual` | INTEGER DEFAULT 0 | Sequência FIFO despacho |
| `created_at` / `updated_at` | TEXT | Auditoria |

**Não existe coluna `nome`.** O KDS exibe `Unidade {codigo}` na seleção (S07-2).  
Índice único: `(empresa_id, codigo)`.

---

## 4. Proposta mínima de implementação (NÃO EXECUTAR AINDA)

Escopo sugerido (sprint futura / autorização TL+PO), **sem** alterar regras S07-2:

### Backend
1. `POST /api/cozinha/unidades` (admin operacional)
   - Body: `{ codigo, ativo? }`
   - Empresa **somente** do contexto autenticado (`X-Empresa-Id` / `req.empresaId`)
   - Validar código não vazio, único na empresa
   - `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)`
2. `GET /api/cozinha/unidades` (admin) — listagem de gestão (ativas e inativas)
3. `PATCH /api/cozinha/unidades/:id` — ativar/inativar (mesmo `empresa_id`)
4. Opcional posterior: CRUD de `cozinha_operador_unidades` para operadores comuns

### Frontend ERP
- Página `cozinha-unidades` (menu Comercial/Config, recurso `pedidos` ou admin)
- Formulário: código + ativo; empresa = contexto já selecionado
- Sem nome até existir coluna (ou exibir código como rótulo)

### Fora do escopo desta proposta
- Auto-criação na abertura do KDS
- Alteração de JWT / isolamento
- PDV / Sprint 06 / fiscal

---

## 5. Procedimento correto para a primeira unidade (oficial)

**Enquanto não houver tela**, o cadastro oficial só pode ocorrer com **autorização explícita PO/TL**, por um dos caminhos:

### A) Preferível após implementar a proposta (item 4)
1. Login admin / SUPER_ADMIN  
2. Selecionar empresa no seletor ERP  
3. Abrir cadastro de unidades → criar código (ex.: `COZ-01`) ativo  
4. Abrir KDS → listar → selecionar → JWT → painel  

### B) Temporário (somente se PO/TL autorizar SQL no oficial)
```sql
INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)
VALUES (<empresa_id_do_contexto>, 'COZ-01', 1, 0);
```
- `empresa_id` = empresa selecionada no ERP (ex.: 1, 2 ou 3 no diagnóstico).  
- Operadores comuns: depois inserir vínculo em `cozinha_operador_unidades`.  
- Admin **não** precisa de vínculo para listar (regra S07-2).

**Este relatório não executa o INSERT no oficial.**

---

## 6. Homologação integrada (banco temporário — evidência do fluxo)

Como o cadastro oficial ainda não foi autorizado, a homologação ponta a ponta foi **comprovada em banco temporário isolado** (mesmo contrato HTTP/JWT/KDS), simulando a existência da primeira unidade:

| Passo | Resultado esperado | Status em teste isolado |
|-------|--------------------|-------------------------|
| Admin lista unidades ativas da empresa | unidade aparece | PASS (S07-2 C / perfil operacional) |
| Admin seleciona unidade (`POST /sessao/unidade`) | 200 + `user` + token | PASS (HTTP J/L) |
| JWT contém `unidade_cozinha_id` | claim = id selecionado | PASS |
| Sessão persistida (token + user) | localStorage / Electron `success:true` | PASS (correções S07-2) |
| Painel KDS abre | `GET /preparacao/painel` 200 | PASS |

Flags: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`.

**Homologação no ambiente oficial** permanece **bloqueada** até o cadastro autorizado da primeira unidade (item 5). Após o cadastro, repetir os mesmos passos na aplicação real (`npm start` já em execução) com usuário admin e empresa selecionada.

---

## 7. Checklist pós-cadastro autorizado (aplicação real)

1. Confirmar `SELECT COUNT(*) FROM cozinha_unidades WHERE empresa_id=? AND ativo=1` ≥ 1  
2. Login admin → empresa correta no contexto  
3. Abrir **Cozinha (KDS)**  
4. Ver unidade na lista (não `SEM_UNIDADES_CADASTRADAS`)  
5. Confirmar unidade → token novo com claim  
6. Painel carrega sem `UNIDADE_OBRIGATORIA`  

---

## 8. Arquivos / artefatos

| Artefato | Função |
|----------|--------|
| Este relatório | Evidência de ausência de tela + proposta + procedimento |
| `Agent/RELATORIO-HOTFIX-S07-2-SEM-UNIDADES.md` | Causa raiz (tabelas vazias) |
| Sem alteração de código nesta etapa | Conformidade com “não executar cadastro / não alterar S07-2” |

---

**Não iniciado S07-3.**  
**Não inserido registro no banco oficial.**  
Aguardando autorização PO/TL para (a) implementar cadastro mínimo **ou** (b) autorizar o primeiro INSERT oficial e homologação visual.
