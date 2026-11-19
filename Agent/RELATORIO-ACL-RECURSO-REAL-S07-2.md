# RELATÓRIO — S07-2 Ajuste final ACL e homologação de recurso

**Data:** 2026-11-17  
**Escopo:** normalização de perfil na ACL + integração real `exigirRecurso('pedidos')`  
**S07-3:** não iniciado | **Banco oficial:** não acessado / não modificado

---

## 1. Ajuste ACL

Em `frontend/shared/js/access-control.js`:

- `obterPermissoesUsuario()`: `perfil` com `.trim().toUpperCase()`
- Gate `cozinha-unidades`:
  ```js
  const perfilNorm = String(perfil || '').trim().toUpperCase();
  return roleNorm === 'admin' || perfilNorm === 'ADMIN' || perfilNorm === 'SUPER_ADMIN';
  ```
- Aceita perfil com espaços / casing misto (`'  admin  '`, `'super_admin'`)

---

## 2. Integração ACL × recurso × admin (investigação)

| Camada | Mecanismo | Efeito |
|--------|-----------|--------|
| Menu ERP | `data-page="cozinha-unidades"` | Visível na navegação |
| ACL página | `PERMISSOES_PAGINAS['cozinha-unidades'] = 'configuracoes'` + **gate admin operacional** | Só role `admin` ou perfil `ADMIN`/`SUPER_ADMIN` |
| API `/api/cozinha/*` | `exigirRecurso('pedidos')` (server + router) | Depende de `configService.recursoHabilitado('pedidos')` |
| Gestão unidades | `isAdminOperacional` no serviço | Operador → `403 ADMIN_OPERACIONAL_OBRIGATORIO` |

**Conclusão de implantação real**

1. Admin operacional **vê o menu** pela ACL (independente da chave `configuracoes` do catálogo).
2. A API **só responde** se o recurso **`pedidos`** estiver habilitado na implantação (`modulo_pedidos` / herança de expedição).
3. Com `pedidos` desligado → `403 MODULO_NAO_LICENCIADO` (proteção preservada).
4. **Não** se liberou `pedidos` artificialmente na ACL nem se removeu `exigirRecurso`.

---

## 3. Teste HTTP sem monkeypatch

Arquivo: `tests/cozinha/sprint07-s07-2-gestao-unidades-recurso-real.test.js`

- Habilita/desabilita via `configService.saveConfig({ modulo_pedidos })`
- Afirma que `recursoHabilitado` permanece a função original
- Admin: GET/POST/PATCH OK com pedidos on
- Operador: 403 na gestão
- Pedidos off: `MODULO_NAO_LICENCIADO`
- Menu/ACL: evidência estática + gate espelhado

**Resultado: 7/7 PASS**

---

## 4. Reexecução completa

| Suite | Resultado | Log |
|-------|-----------|-----|
| Recurso real + ACL | **7/7** | `LOG-ACL-RECURSO-REAL-S07-2.txt` |
| Gestão administrativa | **18/18** | `LOG-GESTAO-UNIDADES-S07-2-POS-ACL.txt` |
| Regressão S07-2 | **47/47** | `LOG-REGRESSAO-S07-2-POS-ACL.txt` |
| Regressão S07-1 | **10/10** | `LOG-REGRESSAO-S07-1-POS-ACL.txt` |

Flags: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`

---

## 5. Entrega auditoria

- Diff: `Agent/DIFF-ACL-RECURSO-REAL-S07-2.patch`
- Este relatório: `Agent/RELATORIO-ACL-RECURSO-REAL-S07-2.md`
- Logs acima

**Confirmações**

- Menu para administrador operacional autorizado: **sim** (ACL + teste)
- API GET/POST/PATCH nas condições corretas: **sim** (pedidos on + admin)
- Proteções mantidas: **sim** (sem liberação artificial de recurso)
