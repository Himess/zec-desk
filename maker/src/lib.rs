//! ZEC Desk's market maker. The decisions ([`decide`]), the book ([`book`]), the prices ([`pricing`]) and the mask
//! ([`mask`]) are plain code; the chain ([`desk`]), FHE ([`fhe`]) and the ZEC leg ([`seam`]) are behind small
//! interfaces; [`engine`] runs the loop and [`handoff`] the off-chain hand-off API.

pub mod book;
pub mod config;
pub mod decide;
pub mod desk;
pub mod engine;
pub mod fhe;
pub mod handoff;
pub mod mask;
pub mod pricing;
pub mod seam;
