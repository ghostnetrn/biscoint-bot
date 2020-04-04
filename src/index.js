import Biscoint from "biscoint-api-node";
import Bottleneck from "bottleneck";
import { handleMessage, handleError, percent } from "./utils";
import config from "./config.js";

let {
  amount,
  initialSell,
  minProfitPercent,
  intervalMs,
  test,
  differencelogger,
} = config;

const bc = new Biscoint({
  apiKey: config.key,
  apiSecret: config.secret,
});

const limiter = new Bottleneck({
  reservoir: 30,
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 1,
});

handleMessage("Successfully started");

let sellOffer = null,
  buyOffer = null,
  lastTrade = 0,
  tradeCycleCount = 0;

setInterval(async () => {
  try {
    sellOffer = await limiter.schedule(() =>
      bc.offer({
        amount,
        isQuote: false,
        op: "sell",
      })
    );

    buyOffer = await limiter.schedule(() =>
      bc.offer({
        amount,
        isQuote: false,
        op: "buy",
      })
    );
  } catch (error) {
    handleError("Error on get offer", error);
  }
  if (Date.now() - lastTrade >= intervalMs) {
    const profit = percent(buyOffer.efPrice, sellOffer.efPrice);
    if (differencelogger)
      handleMessage(`Difference now: ${profit.toFixed(3)}%`);
    if (minProfitPercent <= profit && !test) {
      handleMessage(`Profit found: ${profit.toFixed(3)}%`);
      if (initialSell) {
        /* initial sell */
        try {
          await limiter.schedule(() =>
            bc.confirmOffer({ offerId: sellOffer.offerId })
          );
          handleMessage("Success on sell");
          try {
            await limiter.schedule(() =>
              bc.confirmOffer({
                offerId: buyOffer.offerId,
              })
            );
            handleMessage("Success on buy");
            tradeCycleCount += 1;
            lastTrade = Date.now();
          } catch (error) {
            handleError("Error on buy, retrying", error);
            await forceConfirm("buy", sellOffer.efPrice);
          }
        } catch (error) {
          handleError("Error on sell", error);
          if (error.error === "Insufficient funds") {
            initialSell = !initialSell;
            handleMessage("Switched to first buy");
          }
        }
      } else {
        /* initial buy */
        try {
          await limiter.schedule(() =>
            bc.confirmOffer({ offerId: buyOffer.offerId })
          );
          handleMessage("Success on buy");
          try {
            await limiter.schedule(() =>
              bc.confirmOffer({ offerId: sellOffer.offerId })
            );
            handleMessage("Success on sell");
            tradeCycleCount += 1;
            lastTrade = Date.now();
            handleMessage(`Success, profit: + ${profit.toFixed(3)}%`);
          } catch (error) {
            handleError("Error on sell, retrying", error);
            await forceConfirm("sell", buyOffer.efPrice);
          }
        } catch (error) {
          handleError("Error on buy", error);
          if (error.error === "Insufficient funds") {
            initialSell = !initialSell;
            handleMessage("Switched to first sell");
          }
        }
      }
    }
  }
}, intervalMs);

async function forceConfirm(side, oldPrice) {
  try {
    const offer = await limiter.schedule(() =>
      bc.offer({
        amount,
        isQuote: false,
        op: side,
      })
    );

    // if side is buy then compare with sell price
    if (
      (side === "buy" && oldPrice * 1.001 >= Number(offer.efPrice)) ||
      (side === "sell" && oldPrice * 0.999 <= Number(offer.efPrice))
    ) {
      await limiter.schedule(() => bc.confirmOffer({ offerId: offer.offerId }));
      handleMessage("Success on retry");
    } else throw "Error on forceConfirm, price is much distant";
  } catch (error) {
    handleError("Error on force confirm", error);
  }
}
