# Evidência — rotas S07-3C e middlewares

**Arquivo:** `backend/rotas/cozinha.js`

## Cadeia global do router

```js
router.use(exigirRecurso('pedidos'));
router.use(criarMiddlewareContextoEmpresa(db));
```

No servidor/teste HTTP: `verificarToken` → `exigirRecurso('pedidos')` → `cozinhaRoutes`.

## Rotas S07-3C (linhas ~341–414)

| Método | Path | Empresa | Admin |
|--------|------|---------|-------|
| GET | `/canais` | `empresaIdDoReqPedido(req)` | serviço `exigirAdminOperacional` |
| POST | `/canais` | idem; `body.empresa_id` → `bodyEmpresaIdIgnored` | idem |
| PATCH | `/canais/:id` | idem | idem |
| PUT | `/canais/:id/destino` | idem | idem |

Todos os handlers chamam `exigirCozinhaOperacional(res)` antes do serviço.

Trecho POST (exemplo):

```js
router.post('/canais', async (req, res) => {
  ...
  empresaId: empresaIdDoReqPedido(req),
  nomeRaw: body.nome,
  bodyEmpresaIdIgnored: body.empresa_id != null ? body.empresa_id : body.empresaId
});
```

Admin operacional: `CozinhaCanaisService.js` → `exigirAdminOperacional` → `403 ADMIN_OPERACIONAL_OBRIGATORIO`.
