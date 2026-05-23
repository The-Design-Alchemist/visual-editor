"use client";

import styled from "styled-components";

const Card = styled.div`
  margin-top: 1.5rem;
  padding: 2.5rem;
  background: #ddd6fe;
  border: 1px solid #8b5cf6;
  border-radius: 0.5rem;
  color: #4c1d95;
  font-size: 0.875rem;
  width: 12rem;
  font-weight: 500;
`;

export default function StyledCard() {
  return <Card>styled-components</Card>;
}
