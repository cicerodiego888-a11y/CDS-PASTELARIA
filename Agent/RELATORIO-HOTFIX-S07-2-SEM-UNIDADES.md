# RELATÓRIO — Hotfix S07-2 — KDS sem unidades autorizadas

**Data:** 2026-11-17  
**Status:** ENTREGUE PARA AUDITORIA  
**Escopo:** diagnóstico + diagnóstico API/UI — **sem** criar dados oficiais, sem S07-3

---

## 1. Causa raiz (evidência)

### Requisição
`GET /api/cozinha/unidades-disponiveis`  
(headers: Bearer JWT + `X-Empresa-Id` via `CdsEmpresaContexto`)

### Backend
`CozinhaSessaoUnidadeService.listarUnidadesDisponiveis` + `isAdminOperacional(req.user)`  
Empresa: `empresaIdDoReqPedido(req)` ← contexto autenticado (`req.empresaId`).

### Dados oficiais (cópia **somente leitura** de `ProgramData\MercantilFiscal\dados\mercadao.db`)

| Verificação | Resultado |
|-------------|-----------|
| Tabela `cozinha_unidades` | **0 linhas** |
| Tabela `cozinha_operador_unidades` | **0 linhas** |
| Empresas ativas (1, 2, 3) | Existem |
| Usuários admin (`role=admin`, perfil ADMIN/SUPER_ADMIN) | Existem (ex.: `admin`, `Diego`) |

**Conclusão:** a autorização **não** está classificando admin como operador comum no banco oficial. A lista vazia ocorre porque **não há unidades de cozinha cadastradas/ativas** para nenhuma empresa.  
Admin operacional corretamente executaria `SELECT ... FROM cozinha_unidades WHERE empresa_id=? AND ativo=1` → 0 linhas → mensagem de “sem unidade autorizada”.

Não é falha de JWT, nem de `X-Empresa-Id`, nem de vínculo omitido para admin. É **ausência de cadastro** em `cozinha_unidades`.

---

## 2. Correção implementada (sem enfraquecer S07-2)

### API (`listarUnidadesDisponiveis`)
- Mantém regras: admin/perfil ADMIN|SUPER_ADMIN → todas ativas da empresa; operador → só vínculo ativo.
- Distingue códigos:
  - `SEM_UNIDADES_CADASTRADAS` — empresa sem unidades ativas
  - `SEM_VINCULO_OPERADOR` — há unidades na empresa, operador sem vínculo
- Campos de diagnóstico: `admin_operacional`, `unidades_ativas_empresa`

### `isAdminOperacional`
- `role` comparado em minúsculas (`admin`) — evita falso negativo por capitalização; perfil continua `ADMIN`/`SUPER_ADMIN`.

### Frontend KDS
- Mensagens específicas por código (cadastro vs vínculo).
- Persistência JWT / validação de claim **inalteradas**.

**Não** criados vínculos, **não** promovido usuário, **não** alterado banco oficial.

---

## 3. Arquivos alterados

| Arquivo | Mudança |
|---------|---------|
| `backend/services/cozinha/CozinhaSessaoUnidadeService.js` | Diagnóstico de lista vazia |
| `backend/services/cozinha/cozinhaAuthUnidade.js` | role case-insensitive |
| `frontend/erp/js/cozinha-kds.js` | Mensagens por código |
| `tests/cozinha/sprint07-s07-2-sessao-unidade-kds.test.js` | Casos SEM_* + perfil operacional |

---

## 4. Testes

| Suite | Resultado |
|-------|-----------|
| S07-2 | **47/47** |
| S07-1 | **10/10** |

Inclui: admin vê ativas; perfil ADMIN sem vínculo vê ativas; operador só vínculo; sem vínculo → `SEM_VINCULO_OPERADOR`; sem cadastro → `SEM_UNIDADES_CADASTRADAS`; inativa/outra empresa fora; POST rejeita não autorizado; JWT antes de persistir.

Isolamento: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`.  
Log: `Agent/LOG-HOTFIX-S07-2-SEM-UNIDADES.txt`

---

## 5. Segurança S07-2 preservada

- JWT claim autoritativa; body não substitui unidade.
- Revalidação no POST de seleção.
- Frontend exige claim + `user` antes de persistir.
- Sem auto-seleção; sem criar registros; isolamento por empresa.

---

## 6. Homologação na aplicação real (requer autorização PO/TL)

1. **Não** usar este hotfix para gravar no oficial automaticamente.
2. Com autorização explícita, cadastrar em `cozinha_unidades` ao menos uma unidade **ativa** por empresa que usará o KDS, por exemplo:
   - `empresa_id` = empresa selecionada no ERP
   - `codigo` = identificador operacional (ex.: `COZ-01`)
   - `ativo` = 1
3. Para operadores comuns: inserir vínculo ativo em `cozinha_operador_unidades` (`empresa_id`, `operador_id`, `unidade_id`, `ativo=1`).
4. Admin/perfil ADMIN|SUPER_ADMIN: **não** precisa de vínculo para listar.
5. Reabrir KDS → listagem deve exibir a(s) unidade(s) → selecionar → JWT com `unidade_cozinha_id` → painel.

---

**Não iniciado S07-3.** Aguardar auditoria.
