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
| apresentações | `produto_embalagens` | `tipo` é a embalagem comercial; `quantidade` e `unidade` são o conteúdo (ex.: PCT, 350, G). |
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

### Simulação com alterações pendentes

`POST /api/produtos/:id/conversao/simular` continua usando a configuração persistida quando o corpo não inclui `configuracao`. Para simular alterações ainda não salvas, pode receber:

```json
{
  "quantidade": 5,
  "unidadeOrigem": "UN",
  "unidadeDestino": "KG",
  "configuracao": {
    "utiliza_conversao": 1,
    "unidade_estoque": "KG",
    "relacoes": [{ "unidade_origem": "UN", "unidade_destino": "KG", "fator": 5 }],
    "apresentacoes": []
  }
}
```

Esse modo valida e calcula somente em memória, retorna `persistido: false` e não grava configuração, saldo ou movimento. Sem `configuracao`, a resposta identifica `persistido: true`. Ambos os modos informam origem, resultado, unidade final, caminho e etapas aplicadas; erros incluem origem, destino e motivo.

O formulário indica **Alterações não salvas**, limpa resultados anteriores quando entradas relevantes mudam e rotula a simulação conforme a origem da configuração. Após o salvamento, consulta `/api/produtos/:id/conversao` novamente para confirmar os valores persistidos.

### Atomicidade

`salvarConfiguracao()` valida e grava a flag, unidade e substituição das relações em uma transação `BEGIN IMMEDIATE`. Se qualquer escrita falhar, executa rollback, mantendo os valores anteriores. As apresentações comerciais continuam sendo persistidas pelo serviço existente, fora desta transação da configuração SI.

---

## UI

Painel **Conversão / estoque** dentro do cadastro existente (`frontend/erp/js/produto-embalagens.js`). Sem tela “Cadastro de MUC”.

- Utiliza conversão? Sim / Não
- Unidade de estoque (quando Sim), incluindo PACOTE (PCT)
- Apresentações comerciais (tabela já existente)
- Relações SI (adicionar / editar / remover)
- Simular conversão antes ou depois de salvar o produto

Com flag Sim, a apresentação cadastra quantidade e unidade de conteúdo separadamente da unidade comercial. Exemplos: `1 PCT = 350 G` e `1 CAIXA = 12 UN`. A coluna existente `produto_embalagens.unidade` já persiste a unidade de conteúdo, portanto não é necessária migração de schema.

O cadastro exibe **Qtd. conteúdo** e **Un. conteúdo**. Para uma apresentação ativa usada em compras, ambos devem ser válidos; sem quantidade ou unidade de conteúdo, o cadastro/compra é bloqueado. A conversão do conteúdo para a unidade de estoque é realizada pelo MUC, sem gravar PCT como relação SI.

`PACOTE (PCT)` pode ser selecionado como unidade de estoque para controlar o saldo em pacotes. A apresentação comercial PCT continua sendo uma configuração distinta; por exemplo, `1 PCT = 50 UN` deve ser cadastrada em **Apresentações Comerciais**, não em Relações SI. Com estoque em PACOTE, comprar 1 PCT mantém 1 PACOTE em estoque, enquanto a relação cadastrada permite converter 50 UN para 1 PACOTE. Para controlar o saldo em unidades individuais, selecione UN como unidade de estoque.

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
- Unidade de apresentação conhecida; fator finito e maior que zero
- Relações duplicadas para a mesma origem e destino são rejeitadas; fatores conflitantes retornam `RELACAO_AMBIGUA`
- Origem de embalagem (CAIXA, FARDO, …) **não** entra como relação SI
- Relações entre famílias físicas diferentes (ex.: KG → ML) só são válidas quando cadastradas explicitamente para o produto; não há equivalência universal nem inferência de densidade
- Caminho de cada origem de compra até a unidade de estoque resolvido pelo MUC; senão: *Não existe uma relação cadastrada para converter X em Y.*

Exclusão de relação necessária: `RELACAO_NECESSARIA` (não apaga em silêncio).

---

## Simulação

Os campos são **Quantidade de origem** e **Unidade de origem**. A unidade pode ser escolhida entre as relações e apresentações ativas do formulário ou informada manualmente; o campo não representa a unidade de estoque. O exemplo inicial usa quantidade `1` e a origem da primeira relação cadastrada (ou a unidade de estoque se ainda não houver relação). Ao alterar relações, essa origem padrão acompanha a configuração enquanto o operador não escolher outra unidade manualmente.

Para `1 UN = 5 KG`, a resposta mostra a origem (`1 UN`), cada relação aplicada (`1 UN = 5 KG`), o resultado (`5 KG`) e o caminho do MUC (`UN → KG`). Para uma entrada já em KG, como `5 KG → KG`, mantém a quantidade e informa que nenhuma conversão é necessária. Unidade sem caminho válido resulta em erro explícito.

A interface usa `etapas` e `mensagem` já retornadas pela API; o contrato e o motor MUC não mudam. A simulação não grava configuração nem movimenta estoque. Falhas nunca são exibidas como `0`, `null` ou `NaN` de sucesso.

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

`tests/muc/muc-03-configuracao-produto.test.js` (T01–T27 + integrações Coca, água, laranja) e `tests/muc/muc-simulacao-antes-de-salvar.test.js` (simulação persistida e pendente, sem gravar configuração ou estoque).
