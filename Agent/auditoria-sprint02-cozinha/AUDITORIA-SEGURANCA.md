# AUDITORIA — SEGURANÇA DAS ROTAS (Sprint 02)

---

## Registro efetivo no servidor

```162:162:backend/server.js
const cozinhaRoutes = require('./rotas/cozinha');
```

```245:245:backend/server.js
app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);
```

Camadas aplicadas **antes** do router:

1. `verificarToken` — autenticação JWT/sessão (sem token → bloqueio padrão do middleware global de auth).
2. `exigirRecurso('pedidos')` — autorização por recurso de implantação/licença.

Dentro do router (`backend/rotas/cozinha.js`):

```15:16:backend/rotas/cozinha.js
router.use(exigirRecurso('pedidos'));
router.use(criarMiddlewareContextoEmpresa(db));
```

`exigirRecurso('pedidos')` é aplicado **duas vezes** (server + router) — redundante, não afrouxa a regra.

---

## Contexto da empresa

- Middleware anexa `req.empresaId` após validar empresa e vínculo do usuário.
- Rota usa `empresaIdDoReqPedido(req)` → **apenas** `req.empresaId`.
- Payload de despacho **não** define a empresa; `unidade_id` / `mesa_id` / `atendimento_id` / IDs de pedido são filtrados com `empresa_id` do contexto.

Se o cliente omitir contexto: `req.empresaId=null` (middleware sem `obrigatorio:true`) → serviço `400 EMPRESA_CONTEXT_REQUIRED`.

---

## Manipulação de IDs pelo cliente

| Campo do body | Confiança | Proteção |
|---|---|---|
| `unidade_id` | Cliente | Deve existir e pertencer à empresa; ativa |
| `mesa_id` | Cliente | Deve existir na empresa; **ativo não checado** |
| `atendimento_id` | Cliente | Empresa + mesa + estado OCUPADA |
| `itens[].pedido_id` | Cliente | Empresa + atendimento |
| `itens[].pedido_item_id` | Cliente | Pertence ao pedido |
| `itens[].comanda_id` | Cliente | Empresa + atendimento (+ pedido se preenchido) |
| `empresa_id` no body | Ignorado pelo serviço | Não usado |
| `operador_id` no body | Ignorado | Vem de `req.user` |

Cliente **não** pode escolher a sequência FIFO nem o `numero_rodada`.

---

## Isolamento empresa / unidade

- Todas as leituras críticas usam `empresa_id` do contexto.
- FKs compostas `(id, empresa_id)` no schema (Sprint 01) impedem cruzamento estrutural rodada↔unidade↔comanda↔item.
- Unidade: uma por lote; itens herdam a mesma `unidade_id`.
- Pedido de outra empresa → `404 PEDIDO_NAO_ENCONTRADO` (teste 12) — não vaza existência entre empresas via mensagem específica “outra empresa”.

---

## Acesso sem sessão

Sem `verificarToken` bem-sucedido, a rota não é alcançada. Testes desta Sprint exercitam o **serviço** com `opts.db` (bypass HTTP); a proteção HTTP depende dos middlewares do `server.js`.

---

## Erros e exposição

`responderErro` devolve `{ success, error, mensagem, codigo, detalhes? }`.

- `detalhes` em `QTY_EXCEDE_RESTANTE`: `pedido_item_id`, solicitado, restante (operacional, não segredo).
- `GET /status` e 503 de cozinha não operacional podem incluir objeto `schema` (`getCozinhaSchemaStatus`), com mensagem de erro de migração se houver — informação interna de diagnóstico.

Não há stack traces na resposta padrão da rota.

---

## Observações para o revisor

1. Recurso exigido é `'pedidos'`, não um recurso dedicado `'cozinha'` (alinhado ao contrato da Sprint: “autorização para operar pedidos e cozinha” via pedidos).
2. Ausência de teste HTTP automatizado de 401 sem token nesta Sprint (suite chama o serviço diretamente).
3. Mesa inativa não bloqueada explicitamente (vide `AUDITORIA-DESPACHO.md`).
