# PDV Normal — PDV oficial multiempresa (Pastelaria, Sprint 03.01)

O **PDV Normal** (`/pdv`, `frontend/pdv`) é o único PDV em evolução no Bloco 3. O PDV Universal permanece legado congelado.

```
PDV NORMAL
    ↓
PDV OFICIAL
    ↓
MULTIEMPRESA (contexto explícito: X-Empresa-Id)
    ↓
VENDA          → vendas.empresa_id
    ↓
ESTOQUE        → estoque_empresa.empresa_id
    ↓
CAIXA          → caixa_sessoes.empresa_id
    ↓
PAGAMENTO      → venda_pagamentos via venda_id (dono = venda)
    ↓
FINANCEIRO     → financeiro.empresa_id = venda.empresa_id
    ↓
FISCAL         → empresaIdContexto = venda.empresa_id
```

## Invariantes

- **Produto** compartilhado (sem `produto_empresa` para “resolver” o PDV).
- **Estoque** separado por empresa.
- Contexto autoriza; **não** substitui `venda.empresa_id` persistido.
- MULTIEMPRESA sem contexto: **bloquear**. EMPRESA_SIMPLES continua válida (contrato operacional).
- Conversão PESO/UNIDADE/VOLUME ocorre sobre a quantidade; a baixa usa o estoque da empresa da venda.

## Contrato HTTP do PDV Normal

1. Operador escolhe a empresa no `CdsEmpresaContexto`.
2. `enviarVenda` anexa `X-Empresa-Id`.
3. Backend resolve financeiro + `exigirEmpresaDaOperacao` + caixa da mesma empresa.
4. Persiste `vendas.empresa_id`.
5. Debita `estoque_empresa` dessa empresa (`exigirEmpresa`).
6. Lança financeiro e contas a receber com a mesma empresa.
7. Fiscal, se solicitado, recebe `venda.empresa_id`.

## O que este documento não autoriza

- Evoluir ou basear implementação no PDV Universal.
- Criar segundo motor de PDV, pagamentos ou TEF.
- Usar `empresa_operacional_id` como substituto do contexto em MULTIEMPRESA.
- NFC-e nova, reforma tributária, cardápio/iFood/cubas nesta sprint.

## Atenção operacional

Com o modo global `MULTIEMPRESA`, `VendaApplicationService` ainda despacha atendimento MUV em `POST /api/vendas`. A fundação de ownership do núcleo de venda (`VendaPagamentoService`) está validada; o alinhamento do despacho com o PDV Normal é a próxima implementação do Bloco 3.
