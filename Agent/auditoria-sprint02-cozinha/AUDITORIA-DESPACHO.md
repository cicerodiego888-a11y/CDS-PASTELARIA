# AUDITORIA DO DESPACHO — Sprint 02

Referências ao código em produção (caminhos do projeto). Cópias idênticas em `codigo/`.

---

## 1. Empresa da sessão autenticada

**Rota** (`backend/rotas/cozinha.js`):

```69:77:backend/rotas/cozinha.js
    const out = await CozinhaDespacho.despacharLote({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      unidade_id: body.unidade_id,
      mesa_id: body.mesa_id,
      atendimento_id: body.atendimento_id,
      itens: body.itens
    });
```

`empresaIdDoReqPedido` (`backend/services/pedido/empresaIdDoReqPedido.js`) lê **somente** `req.empresaId` (contexto já validado). Não aceita `body.empresa_id` / CNPJ / user como autoridade.

`req.empresaId` é anexado por `criarMiddlewareContextoEmpresa(db)` (linhas 15–16 da rota), que resolve header `X-Empresa-Id` (ou body/query apenas se ainda não anexado), valida existência/ativo e vínculo usuário↔empresa.

No serviço: `exigirEmpresa(entrada.empresaId)` → 400 `EMPRESA_CONTEXT_REQUIRED` se inválido (linhas 71–76, 161).

Consultas posteriores usam `AND empresa_id = ?` (unidade, mesa, atendimento, comandas, pedidos).

---

## 2. Operador

```30:38:backend/rotas/cozinha.js
function operadorDaSessao(req) {
  const id = Number(req.user && (req.user.id || req.user.usuario_id));
  ...
}
```

Persistido em `cozinha_rodadas.operador_envio_id` e no hash (`responsavel_operador_id`).

---

## 3. Validações: pedido, item, comanda, mesa, atendimento, unidade

| Entidade | Trecho | Comportamento |
|---|---|---|
| Unidade | L312–322 | `WHERE id=? AND empresa_id=?`; exige `ativo=1` |
| Mesa | L324–330 | `WHERE id=? AND empresa_id=?`; **não** checa `ativo` |
| Atendimento | L332–351 | Empresa + mesa vinculada + estado |
| Comandas | L353–371 | Todas da empresa; `atendimento_id` igual ao informado |
| Comanda×pedido | L377–388 | Se `comanda.pedido_id` setado, deve = `pedido_id` do item |
| Pedido | L389–417 | Existe, mesma empresa, mesmo atendimento, status despachável |
| Item | L419–435 | `pedidos_itens.id` + `pedido_id` |

Exemplo concreto — atendimento ativo:

```343:351:backend/services/cozinha/CozinhaDespachoService.js
    if (atendimento.estado === 'FECHAMENTO') {
      throw erro('Atendimento em fechamento.', 409, 'ATENDIMENTO_EM_FECHAMENTO');
    }
    if (atendimento.estado === 'ENCERRADO') {
      throw erro('Atendimento encerrado.', 409, 'ATENDIMENTO_JA_ENCERRADO');
    }
    if (atendimento.estado !== 'OCUPADA') {
      throw erro('Atendimento não está aberto.', 409, 'ATENDIMENTO_NAO_ABERTO');
    }
```

---

## 4. Item / pedido cancelado

Status despacháveis: `PEDIDO | ABERTO | EM_SEPARACAO` (constante L22).

```403:417:backend/services/cozinha/CozinhaDespachoService.js
      const status = String(pedido.status || '').toUpperCase();
      if (status === 'CANCELADO' || status === 'ORCAMENTO') {
        throw erro(..., 409, 'PEDIDO_ESTADO_INCOMPATIVEL');
      }
      if (!STATUS_DESPACHAVEIS.has(status)) {
        throw erro(..., 409, 'PEDIDO_ESTADO_INCOMPATIVEL');
      }
```

Não há coluna de cancelamento por linha de `pedidos_itens` nesta validação.

---

## 5. Quantidade disponível

```437:485:backend/services/cozinha/CozinhaDespachoService.js
      // cria controle na 1ª vez a partir de item.quantidade
      // teto = referencia + autorizacoes ATIVAS
      // liquida = SUM(qty_solicitada - qty_cancelada) em cozinha_itens
      // se solicitado > restante → QTY_EXCEDE_RESTANTE
```

Aritmética: `somarMilessimos` / `subtrairMilessimos` (sem `parseFloat`).

---

## 6. Impedir aumento silencioso do teto

Controle é criado uma vez e **nunca** atualizado a partir de alteração posterior de `pedidos_itens.quantidade`. Teste suite 17 e relatório executivo confirmam.

Operações de autorização/redução existem no schema, mas **não** há serviço Sprint 02 que as execute.

---

## 7. Snapshots de ingredientes

Leitura: `SELECT * FROM pedido_item_ingredientes WHERE pedido_item_id=?` (L487–492).  
Escrita: `INSERT INTO cozinha_item_ingredientes (...)` (L565–581) com `qtySnapshotParaMillis` para quantidade/preço.

---

## 8. Individualização das comandas

Cada `INSERT` de item usa `linha.comanda_id` (L544–557). Resposta inclui `comandas_ids` (set) e cada item com seu `comanda_id` (`montarRespostaRodada`).

---

## 9. Mistura de unidades na mesma rodada

Toda a operação usa **um** `unidade_id` do corpo da requisição. Todos os itens inseridos recebem esse mesmo `unidade_id`.

Não existe campo `unidade_id` por item no payload → não há caminho de “misturar unidades” via itens distintos. Limitação: também não há checagem de unidade preferencial do produto.

---

## 10. Itens duplicados no payload

```197:200:backend/services/cozinha/CozinhaDespachoService.js
    if (vistos.has(pedidoItemId)) {
      throw erro('Item duplicado no lote.', 400, 'ITEM_DUPLICADO_NO_LOTE');
    }
    vistos.add(pedidoItemId);
```

Critério: `pedido_item_id` (não o par pedido+comanda). Reprodução R6 confirma.

---

## 11. Exemplos de códigos de erro observados

| Código | HTTP | Situação |
|---|---|---|
| `EMPRESA_CONTEXT_REQUIRED` | 400 | Sem empresa no contexto |
| `IDEMPOTENCY_REQUIRED` | 400 | Sem chave |
| `ITEM_DUPLICADO_NO_LOTE` | 400 | Item repetido |
| `QTY_PRECISAO_INVALIDA` | 400 | >3 casas |
| `UNIDADE_NAO_ENCONTRADA` / `MESA_NAO_ENCONTRADA` / … | 404 | Escopo empresa |
| `UNIDADE_INATIVA` | 409 | Unidade desligada |
| `ATENDIMENTO_MESA_INCOMPATIVEL` | 409 | Mesa ≠ atendimento |
| `PEDIDO_ESTADO_INCOMPATIVEL` | 409 | Status inválido |
| `QTY_EXCEDE_RESTANTE` | 409 | Saldo insuficiente |
| `IDEMPOTENCY_*` | 409 | Conflitos de chave |
