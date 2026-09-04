# MUC-03 — Configuração de conversão no cadastro de produto

**Status:** implementado sobre MUC-02 (contrato de cálculo inalterado).  
**Autoridade de cálculo:** `backend/motores/muc/` (`converterQuantidade` / `obterMuc`).  
**Autoridade de regra cadastrada:** produto (catálogo compartilhado).  
**Autoridade de saldo:** estoque por `empresa_id` (consumidor).

Não é uma nova auditoria do MUC. Não cria motor paralelo.

---

## Arquitetura

```
CADASTRO DO PRODUTO
        ↓
configuração de conversão  (flag, unidade de estoque, apresentações, relações SI)
        ↓
       MUC
        ↓
compra / ficha / estoque
```

O usuário cadastra a **regra**. O MUC calcula o **resultado**. Compras executa a **entrada**. Estoque registra o **saldo**.

---

## Campos

| Campo | Onde | Semântica |
|---|---|---|
| `utiliza_conversao` | `produtos` (0/1, default 0) | Liga configuração. **Não** define COMERCIAL vs INSUMO. |
| `unidade_estoque` | `produtos` | Destino padrão do MUC quando a flag está SIM. |
| `produtos.unidade` | `produtos` | Com flag SIM, sincronizada com `unidade_estoque`. |
| apresentações | `produto_embalagens` | Ex.: CAIXA com quantidade 12 e unidade de conteúdo UN. |
| relações SI | `muc_produto_relacoes` | Ex.: 1 UN = 2.000 ML. Sem `empresa_id`. |

Flag **NÃO:** o produto usa a unidade normalmente; o sistema não inventa fator, unidade base nem conversão por nome.

Flag **SIM:** exige unidade de estoque válida; habilita apresentações e relações; o caminho compra → estoque deve ser resolvível pelo MUC.

---

## Banco

Reutilizado: `produto_embalagens`, catálogo SI do MUC.

Novo (indispensável para relações de conteúdo sem duplicar apresentação):

```sql
muc_produto_relacoes (
  produto_id, unidade_origem, unidade_destino, fator
  UNIQUE(produto_id, unidade_origem, unidade_destino)
)
```

Colunas em `produtos`: `utiliza_conversao INTEGER NOT NULL DEFAULT 0`, `unidade_estoque TEXT`.

Schema: `backend/services/produtos/produtoConversaoSchema.js` (aplicado após o schema MUC em `database.js`).

Não há `empresa_id` na configuração. Coca-Cola 1 UN = 2.000 ML é a mesma definição para todas as empresas; o saldo permanece separado.

---

## API

| Método | Rota | Função |
|---|---|---|
| GET | `/api/produtos/:id/conversao` | Lê flag, unidade de estoque e relações |
| PUT | `/api/produtos/:id/conversao` | Grava configuração (valida caminho) |
| POST | `/api/produtos/:id/conversao/simular` | Simula quantidade; `estoqueAlterado: false` |
| DELETE | `/api/produtos/:id/conversao/relacoes/:relacaoId` | Exclui relação se o caminho continuar válido |
| POST/PUT | `/api/produtos` | Persiste conversão junto com apresentações |

Payload de save do cadastro: `utiliza_conversao`, `unidade_estoque`, `relacoes`, `embalagens`.

---

## UI

Painel **Conversão / estoque** dentro do cadastro existente (`frontend/erp/js/produto-embalagens.js`). Sem tela “Cadastro de MUC”.

- Utiliza conversão? Sim / Não
- Unidade de estoque (quando Sim)
- Apresentações comerciais (tabela já existente)
- Relações SI (adicionar / editar / remover)
- Simular conversão (produto já salvo)

Com flag Sim, a quantidade da apresentação é em **UN** de conteúdo (1 CAIXA = 12 UN), não o volume final.

---

## Apresentações vs relações SI

Não gravar `1 CAIXA = 24.000 ML` no lugar das duas etapas.

| Etapa | Exemplo | Onde |
|---|---|---|
| Apresentação | 1 CAIXA = 12 UN | `produto_embalagens` |
| Relação SI / conteúdo | 1 UN = 2.000 ML | `muc_produto_relacoes` |

O MUC encadeia CAIXA → UN → ML.

---

## Validações ao salvar (flag SIM)

- Unidade de estoque conhecida e obrigatória
- Apresentação: unidade e quantidade > 0
- Relação: fator > 0, origem ≠ destino, unidade conhecida
- Origem de embalagem (CAIXA, FARDO, …) **não** entra como relação SI
- Famílias físicas incompatíveis (KG → ML sem regra) bloqueadas
- Caminho de cada origem de compra até a unidade de estoque resolvido pelo MUC; senão: *Não existe uma relação cadastrada para converter X em Y.*

Exclusão de relação necessária: `RELACAO_NECESSARIA` (não apaga em silêncio).

---

## Simulação

Não movimenta estoque. Exibe quantidade convertida e caminho (`CAIXA → UN → ML`). Falha com mensagem explícita — nunca 0/null/NaN como “sucesso”.

---

## MUC, compras e estoque

`processarItemCompra` carrega `muc_produto_relacoes` somente se `utiliza_conversao = 1`. Destino do pipeline: `unidade_estoque` (flag SIM) ou `produtos.unidade` (legado).

Compras continua usando `resultadoMuc.quantidadeEstoque`. Sem regra paralela.

Estoque registra a quantidade já convertida na `empresa_id` da operação.

Ficha técnica: regra de negócio **não** mudou nesta sprint; a configuração é compatível (ex. 300 ML → estoque L → 0,3 L via MUC). Integração completa de ficha = MUC-04.

---

## Compatibilidade e migração

Produtos existentes: `utiliza_conversao = 0`. Sem conversão automática a partir de `fator_conversao` legado. Sem migração ampla.

Candidatos futuros (não convertidos): produtos com UC + `quantidade_por_embalagem` e unidade de estoque SI distinta da UC.

---

## Exemplos

**Coca-Cola 2L** — COMERCIAL, conversão SIM, estoque ML, CAIXA×12 UN, 1 UN = 2.000 ML. Compra 12 CAIXAS → 288.000 ML.

**Água 350 ML** — COMERCIAL, SIM, ML, FARDO×12 UN, 1 UN = 350 ML. 10 FARDO → 42.000 ML.

**Carne** — INSUMO, conversão NÃO, KG. 5 KG → 5 KG.

**Laranja** — INSUMO, SIM, estoque KG, 1 UN = 150 G. 20 UN → 3 KG.

---

## Testes

`tests/muc/muc-03-configuracao-produto.test.js` (T01–T25 + integrações Coca, água, laranja).
