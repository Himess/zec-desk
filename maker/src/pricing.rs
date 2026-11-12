//! What the maker quotes: a configured price (testnet) less a spread, inside its size limits and its free inventory.
//! Buy: the user's escrowed cUSDC buys zatoshi. Sell: the user's zatoshi buy cUSDC. Both are floored, so a quote
//! never promises more than the price allows.

use serde::Deserialize;

/// Zatoshi per ZEC.
pub const ZAT_PER_ZEC: u128 = 100_000_000;
const BPS: u128 = 10_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Pricing {
    /// cUSDC base units (6 decimals) per ZEC. On testnet a configured value, not a feed.
    pub zec_price_units: u64,
    /// The maker's margin, in basis points, taken from what it gives.
    pub spread_bps: u32,
    /// Buy: the cUSDC sizes it quotes on.
    pub min_usd_units: u64,
    pub max_usd_units: u64,
    /// Sell: the zatoshi sizes it quotes on.
    pub min_zat: u64,
    pub max_zat: u64,
    /// Buy: zatoshi kept back from each payment's inventory for its fee (ZIP 317).
    pub fee_headroom_zat: u64,
}

/// Why the maker doesn't quote an order. Carries no amount: it is logged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decline {
    TooSmall,
    TooLarge,
    NoInventory,
    ZeroQuote,
}

impl Pricing {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(self.zec_price_units > 0, "pricing: zec_price_units must be positive");
        anyhow::ensure!(u128::from(self.spread_bps) < BPS, "pricing: spread_bps must be under 10000");
        anyhow::ensure!(self.min_usd_units <= self.max_usd_units, "pricing: min_usd_units > max_usd_units");
        anyhow::ensure!(self.min_zat <= self.max_zat, "pricing: min_zat > max_zat");
        Ok(())
    }

    /// Buy: the zatoshi the maker gives for `usd_units` of the user's cUSDC, if it quotes at all. `free_zat` is the
    /// ZEC it has not promised to other orders.
    pub fn quote_buy(&self, usd_units: u64, free_zat: u64) -> Result<u64, Decline> {
        if usd_units < self.min_usd_units {
            return Err(Decline::TooSmall);
        }
        if usd_units > self.max_usd_units {
            return Err(Decline::TooLarge);
        }
        let keep = BPS - u128::from(self.spread_bps);
        let zat = (u128::from(usd_units) * ZAT_PER_ZEC).checked_mul(keep).ok_or(Decline::TooLarge)?
            / (u128::from(self.zec_price_units) * BPS);
        let zat = u64::try_from(zat).map_err(|_| Decline::TooLarge)?;
        if zat == 0 {
            return Err(Decline::ZeroQuote);
        }
        if zat.saturating_add(self.fee_headroom_zat) > free_zat {
            return Err(Decline::NoInventory);
        }
        Ok(zat)
    }

    /// Sell: the cUSDC units the maker gives for the user's `zat`, if it quotes at all. `free_usd_units` is the cUSDC
    /// it has not promised to other orders.
    pub fn quote_sell(&self, zat: u64, free_usd_units: u64) -> Result<u64, Decline> {
        if zat < self.min_zat {
            return Err(Decline::TooSmall);
        }
        if zat > self.max_zat {
            return Err(Decline::TooLarge);
        }
        let keep = BPS - u128::from(self.spread_bps);
        let usd = (u128::from(zat) * u128::from(self.zec_price_units)).checked_mul(keep).ok_or(Decline::TooLarge)?
            / (ZAT_PER_ZEC * BPS);
        let usd = u64::try_from(usd).map_err(|_| Decline::TooLarge)?;
        if usd == 0 {
            return Err(Decline::ZeroQuote);
        }
        if usd > free_usd_units {
            return Err(Decline::NoInventory);
        }
        Ok(usd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> Pricing {
        Pricing {
            zec_price_units: 40_000_000, // 40 cUSDC per ZEC
            spread_bps: 50,
            min_usd_units: 1_000_000,
            max_usd_units: 100_000_000,
            min_zat: 1_000_000,
            max_zat: 500_000_000,
            fee_headroom_zat: 20_000,
        }
    }

    #[test]
    fn buy_gives_the_price_less_the_spread_floored() {
        // 10 cUSDC at 40/ZEC is 0.25 ZEC; less 0.5% is 24,875,000 zat.
        assert_eq!(p().quote_buy(10_000_000, u64::MAX), Ok(24_875_000));
        // 1 unit over the minimum still floors.
        assert_eq!(p().quote_buy(1_000_001, u64::MAX), Ok(2_487_502));
    }

    #[test]
    fn sell_gives_the_price_less_the_spread_floored() {
        // 0.25 ZEC at 40/ZEC is 10 cUSDC; less 0.5% is 9.95 cUSDC.
        assert_eq!(p().quote_sell(25_000_000, u64::MAX), Ok(9_950_000));
        assert_eq!(p().quote_sell(1_000_003, u64::MAX), Ok(398_001));
    }

    #[test]
    fn limits_and_inventory_decline() {
        assert_eq!(p().quote_buy(999_999, u64::MAX), Err(Decline::TooSmall));
        assert_eq!(p().quote_buy(100_000_001, u64::MAX), Err(Decline::TooLarge));
        // 24,875,000 + 20,000 headroom must fit.
        assert_eq!(p().quote_buy(10_000_000, 24_894_999), Err(Decline::NoInventory));
        assert_eq!(p().quote_buy(10_000_000, 24_895_000), Ok(24_875_000));
        assert_eq!(p().quote_sell(999_999, u64::MAX), Err(Decline::TooSmall));
        assert_eq!(p().quote_sell(500_000_001, u64::MAX), Err(Decline::TooLarge));
        assert_eq!(p().quote_sell(25_000_000, 9_949_999), Err(Decline::NoInventory));
    }

    #[test]
    fn the_largest_sizes_do_not_overflow() {
        let mut q = p();
        q.max_usd_units = u64::MAX;
        q.max_zat = u64::MAX;
        q.zec_price_units = 1;
        q.spread_bps = 0;
        assert_eq!(q.quote_buy(u64::MAX, u64::MAX), Err(Decline::TooLarge));
        q.zec_price_units = u64::MAX;
        assert_eq!(q.quote_sell(u64::MAX, u64::MAX), Err(Decline::TooLarge));
        assert!(q.validate().is_ok());
        q.spread_bps = 10_000;
        assert!(q.validate().is_err());
    }
}
